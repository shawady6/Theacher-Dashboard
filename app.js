/* ==========================================================
   Teacher Groups Manager — Vanilla JS, Arabic RTL
   Data persists in localStorage. Single-file architecture.
   ========================================================== */

(() => {
  "use strict";

  /* ---------- Config ---------- */
  const SUPABASE_URL = "https://xbtcnzpzvvmgfnacrfsh.supabase.co";
  const SUPABASE_KEY = "sb_publishable_gR6lLtJaihrGmWpsv6aNNQ_EU8yLeyS";
  const SUPABASE_LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js";
  const LEGACY_KEY = "teacher_groups_manager_v1";   // النسخة القديمة (localStorage) قبل Supabase
  const CACHE_KEY = "tgm_cache_v2";                  // نسخة محلية من بيانات Supabase (للعمل بدون نت)
  const OUTBOX_KEY = "tgm_outbox_v2";                // تغييرات لم تُرفع بعد
  const FAILED_KEY = "tgm_failed_v2";                // تغييرات رفضها السيرفر (للفحص)
  const MIGRATED_KEY = "tgm_legacy_migrated";
  const NUM_LOCALE = "en-US";                        // توحيد الأرقام (غيّرها إلى "ar-EG" لو عايز أرقام هندية)

  const TABLES = ["groups", "students", "attendance", "payments", "exams", "grades"];
  const COLS = {
    groups:     ["id", "name", "monthlyFee", "schedule", "scheduleTimes", "notes", "createdAt"],
    students:   ["id", "name", "phone", "parentName", "parentPhone", "groupId", "notes", "discountEnabled", "discountedFee", "joinedAt"],
    attendance: ["id", "studentId", "groupId", "date", "status"],
    payments:   ["id", "studentId", "groupId", "year", "month", "amount", "status", "paidDate", "note", "createdAt"],
    exams:      ["id", "name", "groupId", "date", "maxGrade", "createdAt"],
    grades:     ["id", "examId", "studentId", "grade", "note"]
  };
  const DATE_COLS = { attendance: ["date"], payments: ["paidDate"], exams: ["date"] };

  const AR_DAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const AR_MONTHS = [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
    "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"
  ];
  const ATT_STATES = [
    { key: "present", label: "حاضر",   cls: "present" },
    { key: "late",    label: "متأخر",  cls: "late" },
    { key: "absent",  label: "غائب",   cls: "absent" }
  ];

  /* ---------- Local state (نسخة من بيانات Supabase) ---------- */
  const blankState = () => ({ groups: [], students: [], attendance: [], payments: [], exams: [], grades: [] });

  let state = loadCache();
  let outbox = loadOutbox();
  let sb = null;                       // Supabase client
  let syncState = "offline";           // ok | syncing | offline | setup
  let renderPending = false;
  let lastMonthly = null;
  let deferredInstall = null;
  let bulk = 0;

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? Object.assign(blankState(), JSON.parse(raw)) : blankState();
    } catch (e) { return blankState(); }
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); }
    catch (e) { console.error(e); toast("تعذر حفظ نسخة على الجهاز (المساحة ممتلئة؟)", "danger"); }
  }
  function loadOutbox() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveOutbox() {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); } catch (e) { /* ignore */ }
  }
  function rememberFailed(op, err) {
    try {
      const list = JSON.parse(localStorage.getItem(FAILED_KEY) || "[]");
      list.push({ at: Date.now(), t: op.t, k: op.k, id: op.id, err: String(err && (err.message || err.code) || err) });
      localStorage.setItem(FAILED_KEY, JSON.stringify(list.slice(-50)));
    } catch (e) { /* ignore */ }
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  const clone = o => JSON.parse(JSON.stringify(o));
  // معرّفات ثابتة: تمنع تكرار سجل الحضور/الدرجة حتى لو اتسجل من جهازين
  const attId = (sid, gid, date) => `att_${sid}_${gid || "none"}_${date}`;
  const grId = (eid, sid) => `gr_${eid}_${sid}`;

  /* ---------- camelCase <-> snake_case ---------- */
  const toSnake = k => k.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
  const toCamel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  function toDb(t, row) {
    const o = {};
    COLS[t].forEach(k => {
      let v = row[k];
      if (v === undefined) return;
      if (v === "" && (DATE_COLS[t] || []).includes(k)) v = null;
      o[toSnake(k)] = v;
    });
    return o;
  }
  function fromDb(row) {
    const o = {};
    for (const k in row) o[toCamel(k)] = row[k];
    return o;
  }

  /* ---------- Outbox (طابور الرفع) ---------- */
  function enqueue(op) {
    const i = outbox.findIndex(o => o.t === op.t && o.id === op.id);
    if (i >= 0) outbox[i] = op; else outbox.push(op);   // نفس المكان => الترتيب (الأب قبل الابن) يفضل سليم
    if (!bulk) { saveOutbox(); updateSyncUI(); scheduleFlush(); }
  }
  let flushTimer = null, retryTimer = null;
  function scheduleFlush(delay) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, delay || 400); }
  function scheduleRetry() { clearTimeout(retryTimer); retryTimer = setTimeout(syncNow, 15000); }

  /* ---------- Low-level writes (محليًا + طابور) ---------- */
  function applyPut(t, row) {
    const arr = state[t];
    const i = arr.findIndex(x => x.id === row.id);
    const before = i >= 0 ? clone(arr[i]) : null;
    if (i >= 0) arr[i] = row; else arr.push(row);
    return before;
  }
  function applyDel(t, id) {
    const arr = state[t];
    const i = arr.findIndex(x => x.id === id);
    if (i < 0) return undefined;
    const before = arr[i];
    arr.splice(i, 1);
    return before;
  }

  /* ---------- Transactions + Undo ---------- */
  let txRec = null;
  const undoStack = [];

  function record(t, id, before) {
    if (!txRec) return;
    const key = t + "/" + id;
    if (txRec.seen.has(key)) return;
    txRec.seen.add(key);
    txRec.items.push({ t, id, before });
  }
  function put(t, row) {
    const before = applyPut(t, row);
    record(t, row.id, before);
    enqueue({ t, k: "u", id: row.id, row: clone(row) });
  }
  function del(t, id) {
    const before = applyDel(t, id);
    if (before === undefined) return;
    record(t, id, before);
    enqueue({ t, k: "d", id });
  }
  // tx: ينفذ مجموعة تغييرات كعملية واحدة قابلة للتراجع، ويظهر زرار "تراجع"
  function tx(label, fn, kind) {
    txRec = { items: [], seen: new Set() };
    let rec;
    try { fn(); } finally { rec = txRec; txRec = null; }
    saveCache();
    if (!rec.items.length) return false;
    undoStack.push({ label, items: rec.items });
    if (undoStack.length > 30) undoStack.shift();
    updateUndoBtn();
    toast(label, kind || "success", { label: "↶ تراجع", fn: undo });
    return true;
  }
  function undo() {
    const e = undoStack.pop();
    if (!e) { toast("لا يوجد ما يمكن التراجع عنه", "info"); return; }
    const modal = document.getElementById("modal");
    if (modal && !modal.hidden) closeModal();
    bulk++;
    for (let i = e.items.length - 1; i >= 0; i--) {
      const it = e.items[i];
      if (it.before) { applyPut(it.t, it.before); enqueue({ t: it.t, k: "u", id: it.id, row: clone(it.before) }); }
      else { applyDel(it.t, it.id); enqueue({ t: it.t, k: "d", id: it.id }); }
    }
    bulk--;
    saveOutbox(); saveCache(); updateUndoBtn(); updateSyncUI(); scheduleFlush();
    toast("تم التراجع: " + e.label, "info");
    render();
  }
  function updateUndoBtn() {
    const b = document.getElementById("undoBtn");
    if (!b) return;
    const last = undoStack[undoStack.length - 1];
    b.disabled = !last;
    b.title = last ? "تراجع عن: " + last.label : "لا يوجد ما يمكن التراجع عنه";
  }

  /* ---------- Sync engine ---------- */
  let flushing = false, pulling = false, rtChannel = null, legacyChecked = false, lastSyncAt = 0;

  function isSetupError(e) {
    if (!e) return false;
    if (["42P01", "PGRST205", "PGRST204", "42501", "PGRST301", "PGRST302"].includes(e.code)) return true;
    if ([401, 403, 404].includes(e.status)) return true;     // مفتاح/صلاحيات/جدول ناقص: لا نحذف أي تغيير
    return /schema cache|does not exist|row-level security|invalid api key|permission denied/i.test(e.message || "");
  }
  function isNetworkError(e) {
    if (!e) return false;
    if (e.code) return false;
    const st = e.status;
    return !st || st >= 500 || /fetch|network|load failed|timeout|abort/i.test(e.message || "");
  }
  function withStatus(res) {
    if (!res || !res.error) return null;
    const err = res.error;
    if (err.status == null) err.status = res.status;
    return err;
  }
  function sendOps(batch) {
    const op = batch[0];
    return op.k === "u"
      ? sb.from(op.t).upsert(batch.map(b => toDb(b.t, b.row)))
      : sb.from(op.t).delete().eq("id", op.id);
  }

  async function flush() {
    if (!sb || flushing || syncState === "setup") return;
    if (!navigator.onLine) { setSync("offline"); return; }
    if (!outbox.length) return;
    flushing = true;
    setSync("syncing");
    let dropped = 0, single = false;
    try {
      while (outbox.length) {
        const first = outbox[0];
        const batch = [first];
        if (first.k === "u" && !single) {
          for (let i = 1; i < outbox.length && batch.length < 200; i++) {
            if (outbox[i].k === "u" && outbox[i].t === first.t) batch.push(outbox[i]); else break;
          }
        }
        let res;
        try { res = await sendOps(batch); }
        catch (e) { setSync("offline"); scheduleRetry(); return; }
        const err = withStatus(res);
        if (err) {
          if (isSetupError(err)) { console.warn("sync setup error", err); setSync("setup"); return; }
          if (isNetworkError(err)) { setSync("offline"); scheduleRetry(); return; }
          if (batch.length > 1) { single = true; continue; }       // نحدد السجل المرفوض
          console.warn("sync op rejected", err, first);
          dropped++; rememberFailed(first, err);
          outbox.shift(); saveOutbox(); updateSyncUI();
          continue;
        }
        outbox.splice(0, batch.length);
        saveOutbox(); updateSyncUI();
      }
      lastSyncAt = Date.now();
      setSync("ok");
    } finally {
      flushing = false;
      updateSyncUI();
      if (dropped) toast(`تعذر رفع ${dropped} تغيير (رفضها السيرفر). راجع إعدادات قاعدة البيانات.`, "danger");
    }
  }

  async function pull() {
    if (!sb || pulling || syncState === "setup") return;
    if (!navigator.onLine) { setSync("offline"); return; }
    pulling = true;
    setSync("syncing");
    try {
      const next = blankState();
      for (const t of TABLES) {
        let from = 0;
        const page = 1000;
        for (;;) {
          const res = await sb.from(t).select("*").order("id").range(from, from + page - 1);
          const err = withStatus(res);
          if (err) throw err;
          next[t].push(...res.data.map(fromDb));
          if (res.data.length < page) break;
          from += page;
        }
      }
      // نعيد تطبيق التغييرات المعلقة محليًا فوق نسخة السيرفر
      for (const op of outbox) {
        const arr = next[op.t];
        const i = arr.findIndex(x => x.id === op.id);
        if (op.k === "u") { if (i >= 0) arr[i] = op.row; else arr.push(op.row); }
        else if (i >= 0) arr.splice(i, 1);
      }
      state = next;
      saveCache();
      lastSyncAt = Date.now();
      setSync(outbox.length ? "offline" : "ok");
      renderSafe();
      if (!legacyChecked) { legacyChecked = true; checkLegacy(); }
    } catch (err) {
      console.warn("pull failed", err);
      setSync(isSetupError(err) ? "setup" : "offline");
      if (!isSetupError(err)) scheduleRetry();
    } finally {
      pulling = false;
    }
  }

  async function syncNow() {
    if (!sb) { startSync(); return; }
    await flush();
    if (!outbox.length && syncState !== "setup") await pull();
  }

  function remoteUpsert(t, row) {
    const arr = state[t];
    const i = arr.findIndex(x => x.id === row.id);
    if (i >= 0) arr[i] = row; else arr.push(row);
  }
  function remoteDelete(t, id) {
    applyDel(t, id);
    if (t === "students") {
      state.attendance = state.attendance.filter(a => a.studentId !== id);
      state.payments = state.payments.filter(p => p.studentId !== id);
      state.grades = state.grades.filter(g => g.studentId !== id);
    } else if (t === "groups") {
      state.students.forEach(s => { if (s.groupId === id) s.groupId = null; });
      state.attendance.forEach(a => { if (a.groupId === id) a.groupId = null; });
      state.payments.forEach(p => { if (p.groupId === id) p.groupId = null; });
      const exIds = state.exams.filter(e => e.groupId === id).map(e => e.id);
      state.exams = state.exams.filter(e => e.groupId !== id);
      state.grades = state.grades.filter(g => !exIds.includes(g.examId));
    } else if (t === "exams") {
      state.grades = state.grades.filter(g => g.examId !== id);
    }
  }
  function onRemote(p) {
    const t = p.table;
    if (!TABLES.includes(t)) return;
    const rec = p.eventType === "DELETE" ? p.old : p.new;
    const id = rec && rec.id;
    if (!id) return;
    if (outbox.some(o => o.t === t && o.id === id)) return;   // تغيير محلي معلّق له الأولوية
    if (p.eventType === "DELETE") remoteDelete(t, id);
    else remoteUpsert(t, fromDb(p.new));
    saveCache();
    renderSafe();
  }
  function startRealtime() {
    if (!sb || rtChannel) return;
    try {
      rtChannel = sb.channel("tgm-changes")
        .on("postgres_changes", { event: "*", schema: "public" }, onRemote)
        .subscribe(status => {
          if (status === "SUBSCRIBED") syncNow();      // عند كل (إعادة) اتصال: نلحق أي تغييرات فاتتنا
        });
    } catch (e) { console.warn("realtime failed", e); }
  }

  function startSync() {
    if (sb) return;
    if (!(window.supabase && window.supabase.createClient)) {
      setSync("offline");
      if (navigator.onLine && !document.getElementById("sbLib")) {
        const s = document.createElement("script");
        s.id = "sbLib"; s.src = SUPABASE_LIB;
        s.onload = () => startSync();
        s.onerror = () => { s.remove(); };
        document.head.appendChild(s);
      }
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    startRealtime();
    syncNow();
  }

  function setSync(s) {
    const was = syncState;
    syncState = s;
    updateSyncUI();
    if ((s === "setup") !== (was === "setup")) updateBanner();
  }
  function updateSyncUI() {
    const el = document.getElementById("syncPill");
    if (!el) return;
    const n = outbox.length;
    const map = {
      ok: "✓ متزامن",
      syncing: "⟳ جاري المزامنة",
      offline: "⚠ غير متصل" + (n ? ` • ${n} معلّق` : ""),
      setup: "⚠ القاعدة غير مجهزة"
    };
    el.className = "sync-pill " + syncState;
    el.textContent = map[syncState] || "";
    el.title = "اضغط للمزامنة الآن";
  }
  function updateBanner() {
    const el = document.getElementById("banner");
    if (!el) return;
    el.innerHTML = syncState === "setup" ? `
      <div class="banner danger">
        <div><strong>قاعدة البيانات غير مجهزة بعد.</strong> افتح Supabase ← SQL Editor وشغّل محتوى ملف <code>schema.sql</code>، وبعدين اضغط "إعادة المحاولة". بياناتك محفوظة على الجهاز مؤقتًا ولن تضيع.</div>
        <button class="btn btn-sm btn-secondary" id="bannerRetry">إعادة المحاولة</button>
      </div>` : "";
  }
  function renderSafe() {
    const ae = document.activeElement;
    const modalOpen = !document.getElementById("modal").hidden;
    const typing = ae && ae.closest && ae.closest("#view") && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName);
    if (modalOpen || typing) { renderPending = true; return; }
    renderPending = false;
    render();
  }
  document.addEventListener("focusout", () => { if (renderPending) setTimeout(renderSafe, 150); });
  document.addEventListener("click", (e) => {
    if (e.target.id === "bannerRetry") { syncState = "offline"; updateBanner(); syncNow(); }
  });
  window.addEventListener("online", () => syncNow());
  window.addEventListener("offline", () => setSync("offline"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastSyncAt > 20000) syncNow();
  });

  /* ---------- Import / legacy migration ---------- */
  // دمج (upsert بالـ id) — آمن لو اتعمل أكتر من مرة
  function importState(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.groups) || !Array.isArray(data.students)) {
      throw new Error("ملف غير صالح: لا يحتوي على بيانات مجموعات أو طلاب صحيحة");
    }
    const arr = k => Array.isArray(data[k]) ? data[k] : [];
    const groups = arr("groups").filter(g => g && g.id && g.name);
    const gIds = new Set([...groups.map(g => g.id), ...state.groups.map(g => g.id)]);
    const students = arr("students").filter(s => s && s.id && s.name)
      .map(s => ({ ...s, groupId: gIds.has(s.groupId) ? s.groupId : null }));
    const sIds = new Set([...students.map(s => s.id), ...state.students.map(s => s.id)]);
    const exams = arr("exams").filter(e => e && e.id && gIds.has(e.groupId));
    const eIds = new Set([...exams.map(e => e.id), ...state.exams.map(e => e.id)]);

    const attMap = new Map();
    arr("attendance").forEach(a => {
      if (!a || !sIds.has(a.studentId) || !a.date || !ATT_STATES.some(x => x.key === a.status)) return;
      const gid = gIds.has(a.groupId) ? a.groupId : null;
      const id = attId(a.studentId, gid, a.date);
      attMap.set(id, { id, studentId: a.studentId, groupId: gid, date: a.date, status: a.status });
    });
    const payments = arr("payments")
      .filter(p => p && p.id && sIds.has(p.studentId) && Number.isFinite(Number(p.amount)) && p.status !== "unpaid")
      .map(p => ({
        ...p, groupId: gIds.has(p.groupId) ? p.groupId : null,
        year: Number(p.year), month: Number(p.month), amount: Number(p.amount),
        status: "paid", paidDate: p.paidDate || null, note: p.note || "", createdAt: p.createdAt || Date.now()
      }));
    const grMap = new Map();
    arr("grades").forEach(g => {
      if (!g || !eIds.has(g.examId) || !sIds.has(g.studentId) || !Number.isFinite(Number(g.grade))) return;
      const id = grId(g.examId, g.studentId);
      grMap.set(id, { id, examId: g.examId, studentId: g.studentId, grade: Number(g.grade), note: g.note || "" });
    });

    const out = { groups, students, attendance: [...attMap.values()], payments, exams, grades: [...grMap.values()] };
    let count = 0;
    bulk++;
    try {
      for (const t of TABLES) {
        for (const row of out[t]) {
          const clean = {};
          COLS[t].forEach(c => { if (row[c] !== undefined) clean[c] = row[c]; });
          applyPut(t, clean);
          enqueue({ t, k: "u", id: clean.id, row: clone(clean) });
          count++;
        }
      }
    } finally { bulk--; }
    saveOutbox(); saveCache(); updateSyncUI(); scheduleFlush();
    return count;
  }

  function readLegacy() {
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function checkLegacy() {
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;
      const data = readLegacy();
      if (!data) return;
      const n = (data.students || []).length;
      const gc = (data.groups || []).length;
      if (!n && !gc) { localStorage.setItem(MIGRATED_KEY, "1"); return; }
      openModal("بيانات قديمة على هذا الجهاز", `
        <p style="margin-top:0">لقينا بيانات من النسخة القديمة محفوظة على هذا الجهاز: <strong>${gc}</strong> مجموعة و<strong>${n}</strong> طالب.</p>
        <p style="color:var(--text-muted);font-size:13px">تحب نرفعها على Supabase عشان تبقى متاحة على كل أجهزتك؟ (الرفع بيدمج البيانات ولا يمسح أي حاجة موجودة)</p>
        <div class="modal-foot">
          <button class="btn btn-secondary" id="legIgnore">لا، تجاهل</button>
          <button class="btn btn-primary" id="legUpload">⬆ رفع البيانات القديمة</button>
        </div>`, (root) => {
        root.querySelector("#legIgnore").addEventListener("click", () => { localStorage.setItem(MIGRATED_KEY, "1"); closeModal(); });
        root.querySelector("#legUpload").addEventListener("click", () => {
          try {
            const c = importState(data);
            localStorage.setItem(MIGRATED_KEY, "1");
            closeModal();
            toast(`تم رفع ${c} سجل من البيانات القديمة`);
            render();
          } catch (e) { toast("تعذر الرفع: " + e.message, "danger"); }
        });
      });
    } catch (e) { console.warn("legacy check failed", e); }
  }

  /* ---------- Date helpers ---------- */
  function fmtDate(d) {
    if (!d) return "—";
    // Parse date-only strings ("YYYY-MM-DD") as LOCAL time, not UTC —
    // otherwise users in western timezones see the previous day.
    const hasTime = /T/.test(d);
    const x = new Date(hasTime ? d : d + "T00:00:00");
    if (isNaN(x)) return "—";
    return `${x.getDate()} ${AR_MONTHS[x.getMonth()]} ${x.getFullYear()}`;
  }
  function todayParts() {
    const x = new Date();
    // JS getDay: 0=Sun..6=Sat, matches our AR_DAYS order (الأحد..السبت)
    return {
      y: x.getFullYear(),
      m: x.getMonth(),
      d: x.getDate(),
      dow: x.getDay(),
      iso: `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,"0")}-${String(x.getDate()).padStart(2,"0")}`
    };
  }
  function isoFromYMD(y, m, d) {
    return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }
  function todayLabel() {
    const t = todayParts();
    return `${AR_DAYS[t.dow]}، ${t.d} ${AR_MONTHS[t.m]} ${t.y}`;
  }
  function monthName(m) { return AR_MONTHS[m] || "—"; }
  function fmtMoney(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString(NUM_LOCALE) + " ج.م";
  }
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function scheduleLabel(days) {
    if (!days || !days.length) return "—";
    return days.slice().sort((a,b)=>a-b).map(d => AR_DAYS[d]).join("، ");
  }
  function fmtTime12(t) {
    if (!t) return "";
    const parts = String(t).split(":");
    const hh = Number(parts[0]), mm = Number(parts[1]);
    if (isNaN(hh) || isNaN(mm)) return "";
    const period = hh >= 12 ? "م" : "ص";
    let h12 = hh % 12; if (h12 === 0) h12 = 12;
    return `${h12}:${String(mm).padStart(2,'0')} ${period}`;
  }
  function dayBadge(dayIndex, scheduleTimes) {
    const time = scheduleTimes && scheduleTimes[dayIndex] ? fmtTime12(scheduleTimes[dayIndex]) : "";
    return `<span class="badge info">${AR_DAYS[dayIndex]}${time ? " " + time : ""}</span>`;
  }
  // Resolves how much a specific student actually owes per month, honoring
  // a per-student discount override if one is enabled (can be 0 for free cases).
  function getStudentDue(s, g) {
    if (s && s.discountEnabled && s.discountedFee !== null && s.discountedFee !== undefined && s.discountedFee !== "") {
      const n = Number(s.discountedFee);
      return isNaN(n) ? Number(g?.monthlyFee || 0) : n;
    }
    return Number(g?.monthlyFee || 0);
  }
  // كل دفعة سجل مستقل. مجموع المدفوع لشهر = مجموع سجلاته.
  function monthPayments(sid, y, m) {
    return state.payments
      .filter(p => p.studentId === sid && Number(p.year) === Number(y) && Number(p.month) === Number(m) && p.status === "paid")
      .sort((a, b) => (a.paidDate || "").localeCompare(b.paidDate || "") || (a.createdAt || 0) - (b.createdAt || 0));
  }
  function paidTotal(sid, y, m) {
    return monthPayments(sid, y, m).reduce((s, p) => s + Number(p.amount || 0), 0);
  }
  // توحيد الحروف العربية للبحث (أ/إ/آ=ا، ى=ي، ة=ه، وإزالة التشكيل)
  function normAr(s) {
    return String(s || "").toLowerCase()
      .replace(/[ً-ٰٟ]/g, "")
      .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  }

  /* ---------- WhatsApp helpers ---------- */
  function normalizeEgyptPhone(phone) {
    if (!phone) return null;
    let p = String(phone).trim().replace(/[^\d+]/g, "");
    if (!p) return null;
    if (p.startsWith("+")) p = p.slice(1);
    if (p.startsWith("00")) p = p.slice(2);
    if (p.startsWith("0")) p = "20" + p.slice(1);        // 01xxxxxxxxx -> 201xxxxxxxxx
    else if (!p.startsWith("20") && p.length === 10) p = "20" + p; // 1xxxxxxxxx -> 201xxxxxxxxx
    return p;
  }
  function isLikelyValidEgyptPhone(phone) {
    // Egyptian mobile numbers: 01[0125]xxxxxxxx (11 digits total)
    return /^01[0125]\d{8}$/.test(String(phone || "").trim());
  }
  function buildWhatsAppLink(phone, message) {
    const num = normalizeEgyptPhone(phone);
    if (!num) return null;
    return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
  }
  function openWhatsAppForAbsence(studentId, dateIso) {
    const s = state.students.find(x => x.id === studentId);
    if (!s) return;
    if (!s.parentPhone) {
      toast("لازم تضيف رقم واتساب ولي الأمر الأول من صفحة الطالب", "danger");
      return;
    }
    if (!isLikelyValidEgyptPhone(s.parentPhone)) {
      toast("رقم واتساب ولي الأمر يبدو غير صحيح، تأكد منه من صفحة الطالب", "danger");
      return;
    }
    const g = state.groups.find(x => x.id === s.groupId);
    const dateLabel = fmtDate(dateIso);
    const message = `السلام عليكم،\nنود إعلامكم أن الطالب/ة ${s.name} كان غائبًا اليوم ${dateLabel}${g ? " في " + g.name : ""}.\nنرجو المتابعة، وشكرًا لتعاونكم.`;
    const link = buildWhatsAppLink(s.parentPhone, message);
    if (link) window.open(link, "_blank");
  }

  function openWhatsAppForDue(studentId, y, m) {
    const s = state.students.find(x => x.id === studentId);
    if (!s) return;
    if (!s.parentPhone) {
      toast("لازم تضيف رقم واتساب ولي الأمر الأول من صفحة الطالب", "danger");
      return;
    }
    if (!isLikelyValidEgyptPhone(s.parentPhone)) {
      toast("رقم واتساب ولي الأمر يبدو غير صحيح، تأكد منه من صفحة الطالب", "danger");
      return;
    }
    y = Number(y); m = Number(m);
    const g = state.groups.find(x => x.id === s.groupId);
    const remaining = Math.max(0, getStudentDue(s, g) - paidTotal(s.id, y, m));
    if (remaining <= 0) { toast("لا يوجد متبقي على هذا الطالب في هذا الشهر", "info"); return; }
    const message = `السلام عليكم،\nنذكّركم بأن المتبقي من مصروفات الطالب/ة ${s.name} عن شهر ${monthName(m)} ${y}${g ? " (" + g.name + ")" : ""} هو ${fmtMoney(remaining)}.\nنرجو التكرم بالسداد في أقرب وقت، وشكرًا لتعاونكم.`;
    const link = buildWhatsAppLink(s.parentPhone, message);
    if (link) window.open(link, "_blank");
  }


  /* ---------- Toast (مع زرار إجراء اختياري مثل "تراجع") ---------- */
  let toastTimer;
  function toast(msg, kind = "success", action) {
    const el = document.getElementById("toast");
    el.className = "toast " + kind;
    el.textContent = msg;
    if (action) {
      const b = document.createElement("button");
      b.className = "toast-btn";
      b.textContent = action.label;
      b.addEventListener("click", () => { el.hidden = true; action.fn(); });
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 2400);
  }

  /* ---------- Modal ---------- */
  function openModal(title, bodyHtml, onMount) {
    const m = document.getElementById("modal");
    document.getElementById("modalTitle").textContent = title;
    const body = document.getElementById("modalBody");
    body.innerHTML = bodyHtml;
    m.hidden = false;
    if (typeof onMount === "function") onMount(body);
  }
  function closeModal() {
    document.getElementById("modal").hidden = true;
    const card = document.querySelector("#modal .modal-card");
    if (card) card.classList.remove("wide");
    if (renderPending) renderSafe();
  }
  document.addEventListener("click", (e) => {
    if (e.target.matches("[data-close]")) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  /* ---------- Router ---------- */
  const titles = {
    dashboard:      { title: "الرئيسية",            sub: "نظرة عامة على مجموعاتك وطلابك" },
    groups:         { title: "المجموعات",           sub: "إدارة مجموعات التقوية والمواعيد" },
    students:       { title: "الطلاب",              sub: "قائمة جميع الطلاب وتوزيعهم على المجموعات" },
    "student-detail": { title: "ملف الطالب",        sub: "تفاصيل الطالب الكاملة" },
    attendance:     { title: "الحضور والانصراف",    sub: "تسجيل حضور الطلاب يومياً" },
    payments:       { title: "المدفوعات",           sub: "تتبع المصروفات والمستحقات الشهرية" },
    exams:          { title: "الامتحانات والدرجات",  sub: "إنشاء امتحانات وتسجيل الدرجات" },
    monthly:        { title: "التقرير الشهري",       sub: "نظرة سريعة على المدفوعات والغياب لكل الطلاب في شهر واحد" }
  };

  let currentView = "dashboard";

  function navigate(view) {
    currentView = view;
    document.querySelectorAll(".nav-item").forEach(el => {
      el.classList.toggle("active", el.dataset.view === view);
    });
    const t = titles[view] || titles.dashboard;
    document.getElementById("pageTitle").textContent = t.title;
    document.getElementById("pageSub").textContent = t.sub;
    render();
  }
  document.querySelectorAll(".nav-item").forEach(el => {
    el.addEventListener("click", () => navigate(el.dataset.view));
  });

  /* ---------- View dispatcher ---------- */
  function render() {
    const view = document.getElementById("view");
    renderPending = false;
    switch (currentView) {
      case "groups":         return view.innerHTML = renderGroups(), bindGroups();
      case "students":       return view.innerHTML = renderStudents(), bindStudents();
      case "student-detail": return view.innerHTML = renderStudentDetail(), bindStudentDetail();
      case "attendance":     return view.innerHTML = renderAttendance(), bindAttendance();
      case "payments":       return view.innerHTML = renderPayments(), bindPayments();
      case "exams":          return view.innerHTML = renderExams(), bindExams();
      case "monthly":        return view.innerHTML = renderMonthlyReport(), bindMonthlyReport();
      default:               return view.innerHTML = renderDashboard(), bindDashboard();
    }
  }

  // إحصائية حضور كل مجموعة (الشهر الحالي) للصفحة الرئيسية
  function renderGroupStats() {
    if (!state.groups.length) return "";
    const t = todayParts();
    const prefix = `${t.y}-${String(t.m + 1).padStart(2, "0")}`;
    const rows = state.groups.map(g => {
      const cnt = state.students.filter(s => s.groupId === g.id).length;
      const att = state.attendance.filter(a => a.groupId === g.id && a.date && a.date.startsWith(prefix));
      const present = att.filter(a => a.status === "present").length;
      const late = att.filter(a => a.status === "late").length;
      const absent = att.filter(a => a.status === "absent").length;
      const sessions = new Set(att.map(a => a.date)).size;
      const rate = att.length ? Math.round(((present + late) / att.length) * 100) : null;
      return { g, cnt, present, late, absent, sessions, rate };
    });
    return `
      <div class="card card-pad-lg" style="margin-top:16px">
        <div class="page-head" style="margin-bottom:14px">
          <h2>إحصائية الحضور لكل مجموعة</h2>
          <span class="badge info">${monthName(t.m)} ${t.y}</span>
        </div>
        <div class="group-stats">
          ${rows.map(r => {
            const color = r.rate === null ? "var(--border-strong)" : r.rate >= 85 ? "var(--success)" : r.rate >= LOW_ATTENDANCE_THRESHOLD ? "var(--accent)" : "var(--danger)";
            return `
              <div class="group-stat">
                <div class="gs-head">
                  <div class="gs-name">${escapeHtml(r.g.name)} <span class="gs-sub">• ${r.cnt} طالب</span></div>
                  <div class="gs-rate" style="color:${r.rate === null ? 'var(--text-soft)' : color}">${r.rate === null ? "لا يوجد سجل" : r.rate + "%"}</div>
                </div>
                <div class="gs-bar"><div style="width:${r.rate || 0}%;background:${color}"></div></div>
                <div class="gs-foot">
                  <span>${r.sessions} حصة مسجلة</span>
                  <span class="badge success">حاضر ${r.present}</span>
                  <span class="badge warning">متأخر ${r.late}</span>
                  <span class="badge danger">غائب ${r.absent}</span>
                </div>
              </div>`;
          }).join("")}
        </div>
      </div>
    `;
  }
  /* ==========================================================
     DASHBOARD
     ========================================================== */
  function renderDashboard() {
    const t = todayParts();
    const totalGroups = state.groups.length;
    const totalStudents = state.students.length;

    // This month payments
    const monthPaid = state.payments.filter(p => p.year === t.y && p.month === t.m && p.status === "paid");
    const monthCollected = monthPaid.reduce((s, p) => s + Number(p.amount || 0), 0);

    // Today's expected groups (schedule contains today's dow)
    const todaysGroups = state.groups.filter(g => g.schedule.includes(t.dow));
    const todaysStudentCount = todaysGroups.reduce((acc, g) => acc + state.students.filter(s => s.groupId === g.id).length, 0);

    // Today's attendance recorded
    const todayAtt = state.attendance.filter(a => a.date === t.iso);
    const presentCount = todayAtt.filter(a => a.status === "present").length;
    const lateCount = todayAtt.filter(a => a.status === "late").length;
    const absentCount = todayAtt.filter(a => a.status === "absent").length;

    return `
      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-label">عدد المجموعات</div>
          <div class="stat-value">${totalGroups}</div>
          <div class="stat-foot">منهم ${todaysGroups.length} مجموعة اليوم</div>
        </div>
        <div class="stat-card info">
          <div class="stat-label">إجمالي الطلاب</div>
          <div class="stat-value">${totalStudents}</div>
          <div class="stat-foot">${todaysStudentCount} طالب متوقع حضورهم اليوم</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">محصل هذا الشهر</div>
          <div class="stat-value">${fmtMoney(monthCollected)}</div>
          <div class="stat-foot">${monthPaid.length} عملية دفع مسجلة</div>
        </div>
        <div class="stat-card accent">
          <div class="stat-label">حضور اليوم</div>
          <div class="stat-value">${todayAtt.length}</div>
          <div class="stat-foot">
            <span class="badge success">حاضر ${presentCount}</span>
            <span class="badge warning" style="margin-right:6px">متأخر ${lateCount}</span>
            <span class="badge danger" style="margin-right:6px">غائب ${absentCount}</span>
          </div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card card-pad-lg">
          <div class="page-head" style="margin-bottom:14px">
            <h2>مجموعات اليوم (${AR_DAYS[t.dow]})</h2>
            <button class="btn btn-secondary btn-sm" data-go="attendance">تسجيل الحضور ←</button>
          </div>
          ${todaysGroups.length === 0 ? `
            <div class="empty">
              <div class="empty-ico">📅</div>
              <div class="empty-title">لا توجد مجموعات مجدولة اليوم</div>
              <div class="empty-sub">تقدر تضيف مواعيد من صفحة المجموعات</div>
            </div>
          ` : `
            <div class="dash-list">
              ${todaysGroups.map(g => {
                const cnt = state.students.filter(s => s.groupId === g.id).length;
                const todayTime = g.scheduleTimes && g.scheduleTimes[t.dow] ? fmtTime12(g.scheduleTimes[t.dow]) : "";
                return `
                  <div class="dash-list-item" data-go-group="${g.id}">
                    <div class="ico">▦</div>
                    <div class="meta">
                      <div class="t">${escapeHtml(g.name)}${todayTime ? ` • ⏰ ${todayTime}` : ""}</div>
                      <div class="s">${cnt} طالب • ${fmtMoney(g.monthlyFee)} / شهر</div>
                    </div>
                    <div class="v">${cnt}</div>
                  </div>
                `;
              }).join("")}
            </div>
          `}
        </div>

        <div class="card card-pad-lg">
          <div class="page-head" style="margin-bottom:14px">
            <h2>إجراءات سريعة</h2>
          </div>
          <div style="display:flex; flex-direction:column; gap:8px">
            <button class="btn btn-primary" data-go="attendance">+ تسجيل حضور اليوم</button>
            <button class="btn btn-secondary" data-go="payments">+ تحصيل دفعة من طالب</button>
            <button class="btn btn-secondary" data-go="exams">+ إضافة امتحان جديد</button>
            <button class="btn btn-secondary" data-go="groups">+ إنشاء مجموعة جديدة</button>
            <button class="btn btn-secondary" data-go="students">+ إضافة طالب جديد</button>
          </div>
        </div>
      </div>

      ${renderGroupStats()}
    `;
  }
  function bindDashboard() {
    document.querySelectorAll("[data-go]").forEach(el => el.addEventListener("click", () => navigate(el.dataset.go)));
    document.querySelectorAll("[data-go-group]").forEach(el => el.addEventListener("click", () => {
      sessionStorage.setItem("focus_group", el.dataset.goGroup);
      navigate("attendance");
    }));
  }

  /* ==========================================================
     GROUPS
     ========================================================== */
  function renderGroups() {
    if (state.groups.length === 0) {
      return `
        <div class="page-head">
          <h2>${state.groups.length} مجموعة</h2>
          <button class="btn btn-primary" id="addGroup">+ مجموعة جديدة</button>
        </div>
        <div class="card empty">
          <div class="empty-ico">▦</div>
          <div class="empty-title">لا توجد مجموعات بعد</div>
          <div class="empty-sub">ابدأ بإنشاء مجموعتك الأولى وحدد المواعيد والمبلغ الشهري</div>
          <div style="margin-top:14px"><button class="btn btn-primary" id="addGroupEmpty">+ إنشاء أول مجموعة</button></div>
        </div>
      `;
    }

    return `
      <div class="page-head">
        <h2>${state.groups.length} مجموعة</h2>
        <button class="btn btn-primary" id="addGroup">+ مجموعة جديدة</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>اسم المجموعة</th>
              <th>المواعيد</th>
              <th>الطلاب</th>
              <th>المبلغ الشهري</th>
              <th>ملاحظات</th>
              <th style="text-align:left">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${state.groups.map(g => {
              const cnt = state.students.filter(s => s.groupId === g.id).length;
              return `
                <tr>
                  <td><strong>${escapeHtml(g.name)}</strong></td>
                  <td><div class="schedule-list">${(g.schedule||[]).slice().sort((a,b)=>a-b).map(d => dayBadge(d, g.scheduleTimes)).join(" ")}</div></td>
                  <td><span class="badge primary">${cnt} طالب</span></td>
                  <td><strong>${fmtMoney(g.monthlyFee)}</strong></td>
                  <td>${escapeHtml(g.notes) || '<span style="color:var(--text-soft)">—</span>'}</td>
                  <td>
                    <div class="table-actions">
                      <button class="btn btn-secondary btn-sm" data-edit-group="${g.id}">تعديل</button>
                      <button class="btn btn-danger btn-sm" data-del-group="${g.id}">حذف</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    `;
  }
  function bindGroups() {
    ["addGroup", "addGroupEmpty"].forEach(id => { const b = document.getElementById(id); if (b) b.addEventListener("click", () => openGroupForm()); });
    document.querySelectorAll("[data-edit-group]").forEach(el => el.addEventListener("click", () => openGroupForm(el.dataset.editGroup)));
    document.querySelectorAll("[data-del-group]").forEach(el => el.addEventListener("click", () => {
      const id = el.dataset.delGroup;
      const g = state.groups.find(x => x.id === id);
      const cnt = state.students.filter(s => s.groupId === id).length;
      const examCnt = state.exams.filter(e => e.groupId === id).length;
      let msg = `حذف "${g.name}"؟`;
      if (cnt > 0) msg += ` يحتوي على ${cnt} طالب. سيتم إبقاؤهم بدون مجموعة.`;
      if (examCnt > 0) msg += ` سيتم حذف ${examCnt} امتحان مرتبط بهذه المجموعة وكل الدرجات المسجلة فيها.`;
      if (!confirm(msg)) return;
      tx("تم حذف المجموعة", () => {
        // الطلاب يفضلوا بدون مجموعة، وسجلات الحضور/المدفوعات تفضل محفوظة
        state.students.filter(s => s.groupId === id).forEach(s => put("students", { ...s, groupId: null }));
        state.attendance.filter(a => a.groupId === id).forEach(a => put("attendance", { ...a, groupId: null }));
        state.payments.filter(p => p.groupId === id).forEach(p => put("payments", { ...p, groupId: null }));
        const examIds = state.exams.filter(e => e.groupId === id).map(e => e.id);
        state.grades.filter(gr => examIds.includes(gr.examId)).forEach(gr => del("grades", gr.id));
        examIds.forEach(eid => del("exams", eid));
        del("groups", id);
      });
      render();
    }));
  }

  function openGroupForm(id) {
    const isEdit = !!id;
    const g = isEdit ? state.groups.find(x => x.id === id) : { name: "", monthlyFee: "", schedule: [], scheduleTimes: {}, notes: "" };

    openModal(isEdit ? "تعديل مجموعة" : "مجموعة جديدة", `
      <form id="groupForm">
        <div class="field">
          <label>اسم المجموعة *</label>
          <input class="input" name="name" required placeholder="مثال: مجموعة الرياضيات - السبت" value="${escapeHtml(g.name)}" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>المبلغ المستحق للشهر (ج.م) *</label>
            <input class="input" type="number" name="monthlyFee" required min="0" step="1" placeholder="مثال: 400" value="${g.monthlyFee || ''}" />
          </div>
          <div class="field">
            <label>ملاحظات</label>
            <input class="input" name="notes" placeholder="اختياري" value="${escapeHtml(g.notes || '')}" />
          </div>
        </div>
        <div class="field">
          <label>المواعيد *</label>
          <div class="preset-row">
            <button type="button" class="preset" data-preset="daily">كل يوم</button>
            <button type="button" class="preset" data-preset="weekend">السبت + الأحد</button>
            <button type="button" class="preset" data-preset="alt">أحد + ثلاثاء + خميس</button>
            <button type="button" class="preset" data-preset="clear">مسح</button>
          </div>
          <div class="weekdays" id="wdPicker"></div>
          <div style="font-size:12px; color:var(--text-soft); margin-top:6px">اختر اليوم أولاً، وهيظهر لك جنبه حقل تحدد فيه ميعاد الحصة في اليوم ده (اختياري)</div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-secondary" data-close>إلغاء</button>
          <button type="submit" class="btn btn-primary">${isEdit ? "حفظ التعديلات" : "إنشاء المجموعة"}</button>
        </div>
      </form>
    `, (root) => {
      const form = root.querySelector("#groupForm");
      const picker = root.querySelector("#wdPicker");
      let schedule = [...(g.schedule || [])];
      let scheduleTimes = { ...(g.scheduleTimes || {}) };

      function renderPicker() {
        picker.innerHTML = AR_DAYS.map((d, i) => {
          const on = schedule.includes(i);
          return `
            <div class="wd-row">
              <button type="button" class="wd ${on ? 'on' : ''}" data-day="${i}">${d}</button>
              ${on ? `<input type="time" class="input wd-time" data-day-time="${i}" value="${scheduleTimes[i] || ''}" />` : ''}
            </div>
          `;
        }).join("");
        picker.querySelectorAll(".wd").forEach(b => b.addEventListener("click", () => {
          const d = +b.dataset.day;
          if (schedule.includes(d)) schedule = schedule.filter(x => x !== d);
          else schedule.push(d);
          renderPicker();
        }));
        picker.querySelectorAll(".wd-time").forEach(inp => inp.addEventListener("change", (e) => {
          const d = +e.target.dataset.dayTime;
          scheduleTimes[d] = e.target.value;
        }));
      }
      renderPicker();

      root.querySelectorAll(".preset").forEach(p => p.addEventListener("click", () => {
        const presets = {
          daily: [0,1,2,3,4,5,6],
          weekend: [6,0],
          alt: [0,2,4],
          clear: []
        };
        schedule = presets[p.dataset.preset];
        renderPicker();
      }));

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const finalScheduleTimes = {};
        schedule.forEach(d => { if (scheduleTimes[d]) finalScheduleTimes[d] = scheduleTimes[d]; });
        const data = {
          name: fd.get("name").trim(),
          monthlyFee: Number(fd.get("monthlyFee")) || 0,
          schedule: schedule.slice().sort((a,b)=>a-b),
          scheduleTimes: finalScheduleTimes,
          notes: fd.get("notes").trim()
        };
        if (!data.name) return toast("اكتب اسم المجموعة", "danger");
        if (!data.schedule.length) return toast("اختر على الأقل يوم واحد للمواعيد", "danger");
        if (isEdit) tx("تم حفظ التعديلات", () => put("groups", { ...g, ...data }));
        else tx("تم إنشاء المجموعة", () => put("groups", { id: uid(), ...data, createdAt: Date.now() }));
        closeModal();
        render();
      });
    });
  }

  /* ==========================================================
     STUDENTS
     ========================================================== */
  function filteredStudents() {
    let filterGroup = sessionStorage.getItem("filter_group") || "";
    if (filterGroup && filterGroup !== "none" && !state.groups.some(g => g.id === filterGroup)) {
      // المجموعة المختارة اتحذفت — نرجّع الفلتر للوضع الافتراضي
      filterGroup = "";
      sessionStorage.removeItem("filter_group");
    }
    const search = normAr((sessionStorage.getItem("student_search") || "").trim());
    let list = state.students.slice();
    if (filterGroup === "none") list = list.filter(s => !s.groupId);
    else if (filterGroup) list = list.filter(s => s.groupId === filterGroup);
    if (search) list = list.filter(s => normAr(s.name + " " + (s.phone || "") + " " + (s.parentName || "") + " " + (s.parentPhone || "")).includes(search));
    list.sort((a, b) => a.name.localeCompare(b.name, "ar"));
    return { list, filterGroup };
  }
  function studentsCountLabel(list) {
    return `${list.length} طالب${list.length !== state.students.length ? ` (من ${state.students.length})` : ""}`;
  }
  function studentsResults(list) {
    if (list.length === 0) {
      return `
        <div class="card empty">
          <div class="empty-ico">♛</div>
          <div class="empty-title">${state.students.length === 0 ? "لا يوجد طلاب بعد" : "لا توجد نتائج"}</div>
          <div class="empty-sub">${state.students.length === 0 ? "ابدأ بإضافة طلابك وتعيينهم لمجموعاتهم" : "جرّب تغيير البحث أو الفلتر"}</div>
        </div>`;
    }
    const t = todayParts();
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>الاسم</th>
              <th>المجموعة</th>
              <th>رقم الطالب</th>
              <th>اسم ولي الأمر</th>
              <th>الحالة المالية (هذا الشهر)</th>
              <th style="text-align:left">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(s => {
              const g = state.groups.find(x => x.id === s.groupId);
              const due = g ? getStudentDue(s, g) : 0;
              const paid = paidTotal(s.id, t.y, t.m);
              let fin;
              if (!g) fin = '<span style="color:var(--text-soft)">—</span>';
              else if (due === 0 && paid === 0) fin = '<span class="badge success">إعفاء كامل</span>';
              else if (paid >= due) fin = `<span class="badge success">سدد ${fmtMoney(paid)}</span>`;
              else if (paid > 0) fin = `<span class="badge warning">جزئي ${fmtMoney(paid)} من ${fmtMoney(due)}</span>`;
              else fin = `<span class="badge warning">يستحق ${fmtMoney(due)}</span>`;
              return `
                <tr>
                  <td><strong>${escapeHtml(s.name)}</strong></td>
                  <td>${g ? `<span class="badge primary">${escapeHtml(g.name)}</span>` : '<span class="badge">بدون مجموعة</span>'}</td>
                  <td>${escapeHtml(s.phone) || '<span style="color:var(--text-soft)">—</span>'}</td>
                  <td>${escapeHtml(s.parentName) || '<span style="color:var(--text-soft)">—</span>'}</td>
                  <td>${fin}</td>
                  <td>
                    <div class="table-actions">
                      <button class="btn btn-primary btn-sm" data-view-student="${s.id}">عرض التفاصيل</button>
                      <button class="btn btn-secondary btn-sm" data-edit-student="${s.id}">تعديل</button>
                      <button class="btn btn-danger btn-sm" data-del-student="${s.id}">حذف</button>
                    </div>
                  </td>
                </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  }

  function renderStudents() {
    const { list, filterGroup } = filteredStudents();
    return `
      <div class="page-head">
        <h2 id="studentsCount">${studentsCountLabel(list)}</h2>
        <div class="toolbar">
          <input class="input" id="studentSearch" placeholder="🔍 ابحث بالاسم أو الرقم..." value="${escapeHtml(sessionStorage.getItem('student_search') || '')}" style="min-width:220px" />
          <select class="select" id="groupFilter">
            <option value="">كل المجموعات</option>
            ${state.groups.map(g => `<option value="${g.id}" ${filterGroup === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join("")}
            <option value="none" ${filterGroup === 'none' ? 'selected' : ''}>بدون مجموعة</option>
          </select>
          <button class="btn btn-primary" id="addStudent">+ طالب جديد</button>
        </div>
      </div>
      <div id="studentsResults">${studentsResults(list)}</div>
    `;
  }

  // تحديث النتائج فقط (بدون إعادة رسم الصفحة) عشان مربع البحث ما يفقدش التركيز
  function updateStudentsResults() {
    const { list } = filteredStudents();
    const c = document.getElementById("studentsCount");
    const r = document.getElementById("studentsResults");
    if (!c || !r) return;
    c.textContent = studentsCountLabel(list);
    r.innerHTML = studentsResults(list);
    bindStudentRows();
  }

  function bindStudentRows() {
    document.querySelectorAll("[data-view-student]").forEach(el => el.addEventListener("click", () => {
      sessionStorage.setItem("focus_student", el.dataset.viewStudent);
      navigate("student-detail");
    }));
    document.querySelectorAll("[data-edit-student]").forEach(el => el.addEventListener("click", () => openStudentForm(el.dataset.editStudent)));
    document.querySelectorAll("[data-del-student]").forEach(el => el.addEventListener("click", () => {
      const id = el.dataset.delStudent;
      const s = state.students.find(x => x.id === id);
      if (!s) return;
      if (!confirm(`حذف الطالب "${s.name}"؟ سيتم حذف كل سجلاته (حضور، مدفوعات، درجات). تقدر تتراجع بعدها مباشرة.`)) return;
      tx("تم حذف الطالب", () => {
        state.attendance.filter(a => a.studentId === id).forEach(a => del("attendance", a.id));
        state.payments.filter(p => p.studentId === id).forEach(p => del("payments", p.id));
        state.grades.filter(g => g.studentId === id).forEach(g => del("grades", g.id));
        del("students", id);
      });
      render();
    }));
  }

  function bindStudents() {
    const addBtn = document.getElementById("addStudent");
    if (addBtn) addBtn.addEventListener("click", () => {
      const filterGroup = sessionStorage.getItem("filter_group") || "";
      let preset = undefined;
      if (filterGroup === "none") preset = null;
      else if (filterGroup) preset = filterGroup;
      openStudentForm(null, preset);
    });

    const search = document.getElementById("studentSearch");
    let searchTimer;
    if (search) search.addEventListener("input", (e) => {
      sessionStorage.setItem("student_search", e.target.value);
      clearTimeout(searchTimer);
      searchTimer = setTimeout(updateStudentsResults, 120);
    });
    const gf = document.getElementById("groupFilter");
    if (gf) gf.addEventListener("change", (e) => {
      sessionStorage.setItem("filter_group", e.target.value);
      render();
    });
    bindStudentRows();
  }

  function openStudentForm(id, presetGroupId) {
    const isEdit = !!id;
    const s = isEdit ? state.students.find(x => x.id === id) : { name: "", phone: "", parentName: "", parentPhone: "", groupId: presetGroupId !== undefined ? presetGroupId : (state.groups[0]?.id || ""), notes: "", discountEnabled: false, discountedFee: null };
    const initialGroup = state.groups.find(x => x.id === s.groupId) || state.groups[0];

    openModal(isEdit ? "تعديل طالب" : "طالب جديد", `
      <form id="studentForm">
        <div class="field">
          <label>اسم الطالب *</label>
          <input class="input" name="name" required value="${escapeHtml(s.name)}" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>رقم الطالب</label>
            <input class="input" name="phone" placeholder="01xxxxxxxxx" value="${escapeHtml(s.phone||'')}" />
          </div>
          <div class="field">
            <label>اسم ولي الأمر</label>
            <input class="input" name="parentName" value="${escapeHtml(s.parentName||'')}" />
          </div>
        </div>
        <div class="field">
          <label>رقم واتساب ولي الأمر</label>
          <input class="input" name="parentPhone" placeholder="01xxxxxxxxx" value="${escapeHtml(s.parentPhone||'')}" />
        </div>
        <div class="field">
          <label>المجموعة</label>
          <select class="select" name="groupId">
            <option value="">— بدون مجموعة —</option>
            ${state.groups.map(g => `<option value="${g.id}" ${s.groupId===g.id?'selected':''}>${escapeHtml(g.name)} • ${fmtMoney(g.monthlyFee)}/شهر</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:0">
            <input type="checkbox" id="discountToggle" name="discountEnabled" ${s.discountEnabled ? 'checked' : ''} style="width:auto" />
            تفعيل تخفيض / خصم لهذا الطالب
          </label>
        </div>
        <div id="discountSection" style="${s.discountEnabled ? '' : 'display:none'}; background:var(--surface-2); border:1px solid var(--border); border-radius:10px; padding:12px; margin-bottom:14px">
          <div style="font-size:13px; color:var(--text-muted); margin-bottom:10px">
            الاشتراك الأصلي للمجموعة: <strong id="originalFeeDisplay">${fmtMoney(initialGroup?.monthlyFee)}</strong> / شهر
          </div>
          <div class="field" style="margin-bottom:0">
            <label>المبلغ المستحق بعد التخفيض (ج.م)</label>
            <input class="input" type="number" name="discountedFee" min="0" step="1" placeholder="مثال: 50 — أو 0 لحالة مجانية بالكامل" value="${s.discountedFee ?? ''}" />
          </div>
        </div>
        <div class="field">
          <label>ملاحظات</label>
          <input class="input" name="notes" value="${escapeHtml(s.notes||'')}" />
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-secondary" data-close>إلغاء</button>
          <button type="submit" class="btn btn-primary">${isEdit ? "حفظ التعديلات" : "إضافة الطالب"}</button>
        </div>
      </form>
    `, (root) => {
      const groupSelect = root.querySelector('select[name="groupId"]');
      const originalFeeDisplay = root.querySelector('#originalFeeDisplay');
      groupSelect.addEventListener('change', () => {
        const gg = state.groups.find(x => x.id === groupSelect.value);
        originalFeeDisplay.textContent = fmtMoney(gg?.monthlyFee);
      });
      const discountToggle = root.querySelector('#discountToggle');
      const discountSection = root.querySelector('#discountSection');
      discountToggle.addEventListener('change', () => {
        discountSection.style.display = discountToggle.checked ? '' : 'none';
      });

      root.querySelector("#studentForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const discountEnabled = fd.get("discountEnabled") === "on";
        const discountedFeeRaw = fd.get("discountedFee");
        if (discountEnabled && (discountedFeeRaw === "" || discountedFeeRaw === null)) {
          return toast("حدد المبلغ المستحق بعد التخفيض (ممكن يكون صفر)، أو ألغِ تفعيل الخصم", "danger");
        }
        const data = {
          name: fd.get("name").trim(),
          phone: fd.get("phone").trim(),
          parentName: fd.get("parentName").trim(),
          parentPhone: fd.get("parentPhone").trim(),
          groupId: fd.get("groupId") || null,
          discountEnabled,
          discountedFee: discountEnabled ? Number(discountedFeeRaw) : null,
          notes: fd.get("notes").trim()
        };
        if (!data.name) return toast("اكتب اسم الطالب", "danger");
        if (isEdit) tx("تم حفظ التعديلات", () => put("students", { ...s, ...data }));
        else tx("تم إضافة الطالب", () => put("students", { id: uid(), ...data, joinedAt: Date.now() }));
        closeModal();
        render();
      });
    });
  }

  /* ==========================================================
     ATTENDANCE
     ========================================================== */
  function renderAttendance() {
    const t = todayParts();
    const focusGroup = sessionStorage.getItem("focus_group") || (state.groups[0]?.id || "");
    const date = sessionStorage.getItem("att_date") || t.iso;

    if (state.groups.length === 0) {
      return `
        <div class="card empty">
          <div class="empty-ico">▦</div>
          <div class="empty-title">لا توجد مجموعات بعد</div>
          <div class="empty-sub">أنشئ مجموعة أولاً لتستطيع تسجيل الحضور</div>
          <div style="margin-top:14px"><button class="btn btn-primary" onclick="document.querySelector('[data-view=groups]').click()">إنشاء مجموعة</button></div>
        </div>
      `;
    }

    const group = state.groups.find(g => g.id === focusGroup) || state.groups[0];
    const students = state.students.filter(s => s.groupId === group.id).sort((a, b) => a.name.localeCompare(b.name, "ar"));
    const rec = state.attendance.filter(a => a.groupId === group.id && a.date === date);
    const present = rec.filter(r => r.status === "present").length;
    const late = rec.filter(r => r.status === "late").length;
    const absent = rec.filter(r => r.status === "absent").length;
    const unrecorded = students.filter(s => !rec.some(r => r.studentId === s.id)).length;
    const dateObj = new Date(date + "T00:00:00");
    const dateLabel = isNaN(dateObj) ? date : `${AR_DAYS[dateObj.getDay()]}، ${dateObj.getDate()} ${AR_MONTHS[dateObj.getMonth()]} ${dateObj.getFullYear()}`;

    return `
      <div class="page-head">
        <h2>تسجيل الحضور</h2>
        <div class="toolbar">
          <select class="select" id="attGroup" style="min-width:240px">
            ${state.groups.map(g => `<option value="${g.id}" ${g.id === group.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join("")}
          </select>
          <input class="input" type="date" id="attDate" value="${date}" />
          <button class="btn btn-secondary" id="attToday">اليوم</button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card success"><div class="stat-label">حاضر</div><div class="stat-value">${present}</div></div>
        <div class="stat-card accent"><div class="stat-label">متأخر</div><div class="stat-value">${late}</div></div>
        <div class="stat-card" style="--primary:#EF4444"><div class="stat-label">غائب</div><div class="stat-value">${absent}</div></div>
        <div class="stat-card info"><div class="stat-label">إجمالي</div><div class="stat-value">${students.length}</div><div class="stat-foot">${unrecorded} لم يُسجَّل بعد</div></div>
      </div>

      <div class="card card-pad-lg">
        <div class="page-head" style="margin-bottom:14px">
          <h2>${escapeHtml(group.name)} • ${dateLabel}</h2>
          <div class="schedule-list">
            ${(group.schedule || []).slice().sort((a, b) => a - b).map(d => dayBadge(d, group.scheduleTimes)).join(" ")}
          </div>
        </div>

        ${students.length === 0 ? `
          <div class="empty">
            <div class="empty-ico">♛</div>
            <div class="empty-title">لا يوجد طلاب في هذه المجموعة</div>
            <div class="empty-sub">أضف طلاباً من صفحة الطلاب</div>
          </div>
        ` : `
          <div class="att-bulk">
            <button class="btn btn-success" id="attAllPresent" ${unrecorded ? '' : 'disabled'}>✓ تحضير الكل حاضر${unrecorded ? ` (${unrecorded})` : ''}</button>
            <span class="att-bulk-hint">يسجّل "حاضر" لكل من لم يُسجَّل له شيء — وتقدر تعدّل الغائبين بعدها</span>
          </div>
          <div class="table-wrap" style="border:none">
            <div class="att-head">
              <div style="flex:1">الطالب</div>
              <div class="att-head-state">الحالة</div>
            </div>
            ${students.map(s => {
              const r = rec.find(x => x.studentId === s.id);
              const isAbsent = r && r.status === "absent";
              return `
                <div class="att-row">
                  <div class="who">${escapeHtml(s.name)}</div>
                  <div class="opts">
                    ${ATT_STATES.map(st => `
                      <button class="opt-btn ${st.cls} ${r && r.status === st.key ? 'on' : ''}" data-att="${s.id}|${st.key}">${st.label}</button>
                    `).join("")}
                    ${isAbsent ? `<button class="btn btn-sm btn-whatsapp" data-notify-absence="${s.id}" title="إرسال تنبيه غياب لولي الأمر عبر واتساب">📱 تنبيه ولي الأمر</button>` : ''}
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        `}
      </div>
    `;
  }
  function bindAttendance() {
    const ag = document.getElementById("attGroup");
    if (ag) ag.addEventListener("change", e => {
      sessionStorage.setItem("focus_group", e.target.value);
      render();
    });
    const ad = document.getElementById("attDate");
    if (ad) ad.addEventListener("change", e => {
      sessionStorage.setItem("att_date", e.target.value);
      render();
    });
    const at = document.getElementById("attToday");
    if (at) at.addEventListener("click", () => {
      sessionStorage.setItem("att_date", todayParts().iso);
      render();
    });

    const curDate = () => (document.getElementById("attDate") && document.getElementById("attDate").value) || todayParts().iso;
    const curGroup = () => document.getElementById("attGroup").value;

    const all = document.getElementById("attAllPresent");
    if (all) all.addEventListener("click", () => {
      const date = curDate(), gid = curGroup();
      const todo = state.students.filter(s => s.groupId === gid &&
        !state.attendance.some(a => a.studentId === s.id && a.groupId === gid && a.date === date));
      if (!todo.length) { toast("كل الطلاب مسجَّل لهم حضور بالفعل", "info"); return; }
      tx(`تم تحضير ${todo.length} طالب (حاضر)`, () => {
        todo.forEach(s => put("attendance", { id: attId(s.id, gid, date), studentId: s.id, groupId: gid, date, status: "present" }));
      });
      render();
    });

    document.querySelectorAll("[data-att]").forEach(el => el.addEventListener("click", () => {
      const [sid, status] = el.dataset.att.split("|");
      const date = curDate(), gid = curGroup();
      const s = state.students.find(x => x.id === sid);
      const st = ATT_STATES.find(x => x.key === status);
      const existing = state.attendance.find(a => a.studentId === sid && a.groupId === gid && a.date === date);
      if (existing && existing.status === status) return;     // نفس الحالة — لا شيء يتغير
      tx(`${s ? s.name : ""}: ${st.label}`, () => {
        put("attendance", { id: existing ? existing.id : attId(sid, gid, date), studentId: sid, groupId: gid, date, status });
      });
      render();
    }));
    document.querySelectorAll("[data-notify-absence]").forEach(el => el.addEventListener("click", () => {
      openWhatsAppForAbsence(el.dataset.notifyAbsence, curDate());
    }));
  }

  /* ==========================================================
     PAYMENTS
     ========================================================== */
  function renderPayments() {
    const t = todayParts();
    const y = Number(sessionStorage.getItem("pay_y") || t.y);
    const m = Number(sessionStorage.getItem("pay_m") || t.m);
    let filterGroup = sessionStorage.getItem("pay_filter_group") || "";
    if (filterGroup && !state.groups.some(g => g.id === filterGroup)) {
      filterGroup = "";
      sessionStorage.removeItem("pay_filter_group");
    }

    if (state.groups.length === 0) {
      return `
        <div class="card empty">
          <div class="empty-ico">$</div>
          <div class="empty-title">لا توجد مجموعات</div>
          <div class="empty-sub">أنشئ مجموعات أولاً لتتبع المدفوعات</div>
        </div>
      `;
    }

    // صف لكل طالب داخل مجموعة؛ المدفوع = مجموع كل دفعاته في الشهر
    let rows = state.students.filter(s => s.groupId).map(s => {
      const g = state.groups.find(x => x.id === s.groupId);
      const pays = monthPayments(s.id, y, m);
      const paid = pays.reduce((acc, p) => acc + Number(p.amount || 0), 0);
      const due = getStudentDue(s, g);
      const lastDate = pays.length ? pays[pays.length - 1].paidDate : null;
      const status = (due === 0 && paid === 0) ? "free" : (paid >= due && paid > 0) ? "paid" : paid > 0 ? "partial" : "unpaid";
      return { s, g, pays, paid, due, lastDate, status };
    }).filter(r => r.g);

    if (filterGroup) rows = rows.filter(r => r.g.id === filterGroup);
    rows.sort((a, b) => a.s.name.localeCompare(b.s.name, "ar"));

    const totalDue = rows.reduce((acc, r) => acc + r.due, 0);
    const totalCollected = rows.reduce((acc, r) => acc + r.paid, 0);
    const totalRemaining = rows.reduce((acc, r) => acc + Math.max(0, r.due - r.paid), 0);
    const paidCount = rows.filter(r => r.status === "paid" || r.status === "free").length;
    const partialCount = rows.filter(r => r.status === "partial").length;
    const unpaidCount = rows.filter(r => r.status === "unpaid").length;

    return `
      <div class="page-head">
        <h2>${monthName(m)} ${y}</h2>
        <div class="toolbar">
          <select class="select" id="payMonth">
            ${AR_MONTHS.map((mn, i) => `<option value="${i}" ${i === m ? 'selected' : ''}>${mn}</option>`).join("")}
          </select>
          <select class="select" id="payYear">
            ${[y - 1, y, y + 1].map(yy => `<option value="${yy}" ${yy === y ? 'selected' : ''}>${yy}</option>`).join("")}
          </select>
          <select class="select" id="payGroupFilter" style="min-width:180px">
            <option value="">كل المجموعات</option>
            ${state.groups.map(g => `<option value="${g.id}" ${filterGroup === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join("")}
          </select>
          <button class="btn btn-primary" id="addPay">+ تسجيل دفعة</button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card success"><div class="stat-label">إجمالي المحصل</div><div class="stat-value">${fmtMoney(totalCollected)}</div><div class="stat-foot">${paidCount} مسدد • ${partialCount} جزئي</div></div>
        <div class="stat-card accent"><div class="stat-label">المستحق المتبقي</div><div class="stat-value">${fmtMoney(totalRemaining)}</div><div class="stat-foot">${unpaidCount} غير مسدد</div></div>
        <div class="stat-card"><div class="stat-label">إجمالي المستحق</div><div class="stat-value">${fmtMoney(totalDue)}</div><div class="stat-foot">${rows.length} طالب</div></div>
        <div class="stat-card info"><div class="stat-label">نسبة التحصيل</div><div class="stat-value">${totalDue > 0 ? Math.min(100, Math.round((totalCollected / totalDue) * 100)) : 0}%</div><div class="stat-foot">لهذا الشهر</div></div>
      </div>

      ${rows.length === 0 ? `
        <div class="card empty">
          <div class="empty-ico">$</div>
          <div class="empty-title">لا يوجد طلاب ${filterGroup ? 'في هذه المجموعة' : 'في مجموعات'}</div>
          <div class="empty-sub">${filterGroup ? 'جرّب تغيير الفلتر' : 'أضف طلاباً وعيّنهم لمجموعات أولاً'}</div>
        </div>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الطالب</th>
                <th>المجموعة</th>
                <th>المستحق</th>
                <th>المدفوع</th>
                <th>المتبقي</th>
                <th>الحالة</th>
                <th>آخر دفعة</th>
                <th style="text-align:left">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(({ s, g, pays, paid, due, lastDate, status }) => {
                const remaining = Math.max(0, due - paid);
                const badge = {
                  paid: '<span class="badge success">مسدد بالكامل</span>',
                  partial: '<span class="badge warning">دفع جزئي</span>',
                  free: '<span class="badge success">إعفاء كامل</span>',
                  unpaid: '<span class="badge danger">غير مسدد</span>'
                }[status];
                const key = `${s.id}|${y}|${m}`;
                let actions = "";
                if (status === "unpaid") actions += `<button class="btn btn-success btn-sm" data-pay="${key}|${due}">+ تسديد (${fmtMoney(due)})</button>`;
                else if (status === "partial") actions += `<button class="btn btn-accent btn-sm" data-pay="${key}|${remaining}">دفع الباقي (${fmtMoney(remaining)})</button>`;
                if (pays.length) actions += `<button class="btn btn-secondary btn-sm" data-pay-history="${key}">سجل الدفعات (${pays.length})</button>`;
                if (remaining > 0) actions += `<button class="btn btn-whatsapp btn-sm" data-remind="${key}" title="تذكير ولي الأمر بالمتبقي عبر واتساب">📱</button>`;
                return `
                  <tr>
                    <td><strong>${escapeHtml(s.name)}</strong></td>
                    <td><span class="badge primary">${escapeHtml(g.name)}</span></td>
                    <td>${fmtMoney(due)}${s.discountEnabled ? ' <span class="badge warning" title="مبلغ مخفض عن الاشتراك الأصلي">مخفض</span>' : ''}</td>
                    <td><strong>${paid > 0 ? fmtMoney(paid) : '—'}</strong>${pays.length > 1 ? ` <span class="badge">${pays.length} دفعات</span>` : ''}</td>
                    <td>${remaining > 0 ? fmtMoney(remaining) : '<span style="color:var(--success)">✓</span>'}</td>
                    <td>${badge}</td>
                    <td>${lastDate ? fmtDate(lastDate) : '<span style="color:var(--text-soft)">—</span>'}</td>
                    <td><div class="table-actions">${actions}</div></td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `}
    `;
  }
  function bindPayments() {
    const pm = document.getElementById("payMonth");
    if (pm) pm.addEventListener("change", e => { sessionStorage.setItem("pay_m", e.target.value); render(); });
    const py = document.getElementById("payYear");
    if (py) py.addEventListener("change", e => { sessionStorage.setItem("pay_y", e.target.value); render(); });
    const pg = document.getElementById("payGroupFilter");
    if (pg) pg.addEventListener("change", e => { sessionStorage.setItem("pay_filter_group", e.target.value); render(); });

    const ap = document.getElementById("addPay");
    if (ap) ap.addEventListener("click", () => openPaymentForm());

    document.querySelectorAll("[data-pay]").forEach(el => el.addEventListener("click", () => {
      const [sid, y, m, amt] = el.dataset.pay.split("|");
      openPaymentForm(sid, Number(y), Number(m), Number(amt));
    }));
    document.querySelectorAll("[data-pay-history]").forEach(el => el.addEventListener("click", () => {
      const [sid, y, m] = el.dataset.payHistory.split("|");
      openPaymentHistory(sid, Number(y), Number(m));
    }));
    document.querySelectorAll("[data-remind]").forEach(el => el.addEventListener("click", () => {
      const [sid, y, m] = el.dataset.remind.split("|");
      openWhatsAppForDue(sid, Number(y), Number(m));
    }));
  }

  // سجل دفعات طالب في شهر معين (كل دفعة سجل مستقل بتاريخها، وتقدر تحذف أي واحدة)
  function openPaymentHistory(sid, y, m) {
    const s = state.students.find(x => x.id === sid);
    if (!s) return;
    const g = state.groups.find(x => x.id === s.groupId);
    const due = getStudentDue(s, g);
    const pays = monthPayments(sid, y, m);
    const paid = pays.reduce((acc, p) => acc + Number(p.amount || 0), 0);
    const remaining = Math.max(0, due - paid);

    openModal(`دفعات ${s.name} — ${monthName(m)} ${y}`, `
      <div class="pay-summary">
        <div><span>المستحق</span><strong>${fmtMoney(due)}</strong></div>
        <div><span>المدفوع</span><strong style="color:var(--success)">${fmtMoney(paid)}</strong></div>
        <div><span>المتبقي</span><strong style="color:${remaining > 0 ? 'var(--danger)' : 'var(--success)'}">${remaining > 0 ? fmtMoney(remaining) : '✓'}</strong></div>
      </div>
      ${pays.length === 0 ? '<div class="empty" style="padding:24px"><div class="empty-sub">لا توجد دفعات في هذا الشهر</div></div>' : `
        <div class="table-wrap" style="border:none">
          <table>
            <thead><tr><th>التاريخ</th><th>المبلغ</th><th>ملاحظات</th><th></th></tr></thead>
            <tbody>
              ${pays.map(p => `
                <tr>
                  <td>${fmtDate(p.paidDate)}</td>
                  <td><strong>${fmtMoney(p.amount)}</strong></td>
                  <td>${escapeHtml(p.note) || '<span style="color:var(--text-soft)">—</span>'}</td>
                  <td><button class="btn btn-danger btn-sm" data-del-pay="${p.id}">حذف</button></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`}
      <div class="modal-foot">
        <button type="button" class="btn btn-secondary" data-close>إغلاق</button>
        <button type="button" class="btn btn-primary" id="histAdd">+ دفعة جديدة</button>
      </div>
    `, (root) => {
      root.querySelectorAll("[data-del-pay]").forEach(b => b.addEventListener("click", () => {
        const id = b.dataset.delPay;
        const p = state.payments.find(x => x.id === id);
        if (!p) return;
        if (!confirm(`حذف دفعة ${fmtMoney(p.amount)} بتاريخ ${fmtDate(p.paidDate)}؟`)) return;
        tx("تم حذف الدفعة", () => del("payments", id));
        render();
        openPaymentHistory(sid, y, m);
      }));
      root.querySelector("#histAdd").addEventListener("click", () => {
        closeModal();
        openPaymentForm(sid, y, m, remaining > 0 ? remaining : "");
      });
    });
  }

  function openPaymentForm(targetStudentId, targetYear, targetMonth, suggestedAmount) {
    const t = todayParts();
    const y = targetYear !== undefined ? targetYear : Number(sessionStorage.getItem("pay_y") || t.y);
    const m = targetMonth !== undefined ? targetMonth : Number(sessionStorage.getItem("pay_m") || t.m);

    const preSelectedId = targetStudentId || "";
    const preAmount = (suggestedAmount !== undefined && suggestedAmount !== null && suggestedAmount !== "") ? suggestedAmount : "";
    const locked = !!preSelectedId;
    const prevPaid = locked ? paidTotal(preSelectedId, y, m) : 0;

    const eligible = state.students.filter(s => s.groupId && state.groups.some(g => g.id === s.groupId))
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
    if (eligible.length === 0) return toast("لا يوجد طلاب في مجموعات", "danger");

    openModal(prevPaid > 0 ? "دفعة إضافية" : "تسجيل دفعة", `
      <form id="payForm">
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px">عن شهر <strong>${monthName(m)} ${y}</strong></div>
        <div class="field">
          <label>الطالب *</label>
          <select class="select" id="payStudent" ${locked ? 'disabled' : 'name="studentId" required'}>
            ${eligible.map(s => {
              const g = state.groups.find(x => x.id === s.groupId);
              const paid = paidTotal(s.id, y, m);
              const due = getStudentDue(s, g);
              let label = `${escapeHtml(s.name)} • ${escapeHtml(g.name)}`;
              if (s.discountEnabled) label += ` (مخفض)`;
              if (paid >= due && due > 0) label += ` • (مسدد ${fmtMoney(paid)})`;
              else if (paid > 0) label += ` • (دفع ${fmtMoney(paid)} من ${fmtMoney(due)})`;
              else label += ` • ${fmtMoney(due)}`;
              return `<option value="${s.id}" data-fee="${due}" data-paid="${paid}" ${s.id === preSelectedId ? 'selected' : ''} ${(!locked && due > 0 && paid >= due) ? 'disabled' : ''}>${label}</option>`;
            }).join("")}
          </select>
          ${locked ? `<input type="hidden" name="studentId" value="${preSelectedId}" />` : ''}
        </div>
        ${prevPaid > 0 ? `
          <div style="background:var(--warning-100);color:#92400E;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px">
            <strong>ملاحظة:</strong> تم دفع ${fmtMoney(prevPaid)} سابقاً هذا الشهر. هتتسجل دفعة جديدة منفصلة بتاريخها.
          </div>
        ` : ''}
        <div class="field-row">
          <div class="field">
            <label>المبلغ (ج.م) *</label>
            <input class="input" type="number" name="amount" id="payAmount" required min="1" step="1" value="${preAmount || ''}" />
          </div>
          <div class="field">
            <label>تاريخ الدفع *</label>
            <input class="input" type="date" name="paidDate" value="${todayParts().iso}" required />
          </div>
        </div>
        <div class="field">
          <label>ملاحظات</label>
          <input class="input" name="note" placeholder="اختياري" />
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-secondary" data-close>إلغاء</button>
          <button type="submit" class="btn btn-primary">تسجيل الدفعة</button>
        </div>
      </form>
    `, (root) => {
      const sel = root.querySelector("#payStudent");
      const amt = root.querySelector("#payAmount");

      if (!locked) {
        const sync = () => {
          const opt = sel.selectedOptions[0];
          if (opt) {
            const rest = Number(opt.dataset.fee || 0) - Number(opt.dataset.paid || 0);
            amt.value = rest > 0 ? rest : "";
          }
        };
        sel.addEventListener("change", sync);
        if (!preAmount) sync();
      }

      root.querySelector("#payForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const sid = fd.get("studentId");
        const s = state.students.find(x => x.id === sid);
        if (!s) return;
        const amount = Number(fd.get("amount")) || 0;
        if (amount <= 0) return toast("اكتب مبلغ صحيح", "danger");
        tx("تم تسجيل الدفعة", () => {
          put("payments", {
            id: uid(), studentId: sid, groupId: s.groupId, year: y, month: m,
            amount, status: "paid", paidDate: fd.get("paidDate"), note: (fd.get("note") || "").trim(), createdAt: Date.now()
          });
        });
        closeModal();
        render();
      });
    });
  }
function openExamForm(id) {
    const isEdit = !!id;
    const e = isEdit ? state.exams.find(x => x.id === id) : { name: "", groupId: sessionStorage.getItem("focus_exam_group") || state.groups[0]?.id, date: todayParts().iso, maxGrade: 50 };
    openModal(isEdit ? "تعديل امتحان" : "امتحان جديد", `
      <form id="examForm">
        <div class="field">
          <label>اسم الامتحان *</label>
          <input class="input" name="name" required placeholder="مثال: امتحان نص الشهر" value="${escapeHtml(e.name)}" />
        </div>
        <div class="field-row">
          <div class="field">
            <label>المجموعة *</label>
            <select class="select" name="groupId" required>
              ${state.groups.map(g => `<option value="${g.id}" ${e.groupId===g.id?'selected':''}>${escapeHtml(g.name)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>التاريخ *</label>
            <input class="input" type="date" name="date" required value="${e.date}" />
          </div>
        </div>
        <div class="field">
          <label>الدرجة النهائية *</label>
          <input class="input" type="number" name="maxGrade" required min="1" step="1" value="${e.maxGrade}" />
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-secondary" data-close>إلغاء</button>
          <button type="submit" class="btn btn-primary">${isEdit ? "حفظ التعديلات" : "إنشاء الامتحان"}</button>
        </div>
      </form>
    `, (root) => {
      root.querySelector("#examForm").addEventListener("submit", (e2) => {
        e2.preventDefault();
        const fd = new FormData(e2.target);
        const data = {
          name: fd.get("name").trim(),
          groupId: fd.get("groupId"),
          date: fd.get("date"),
          maxGrade: Number(fd.get("maxGrade")) || 50
        };
        if (!data.name) return toast("اكتب اسم الامتحان", "danger");
        if (isEdit) tx("تم حفظ التعديلات", () => put("exams", { ...e, ...data }));
        else {
          const ex = { id: uid(), ...data, createdAt: Date.now() };
          tx("تم إنشاء الامتحان", () => put("exams", ex));
          sessionStorage.setItem("focus_exam", ex.id);
        }
        closeModal();
        render();
      });
    });
  }


  /* ==========================================================
     STUDENT DETAIL
     ========================================================== */
  function renderStudentDetail() {
    const sid = sessionStorage.getItem("focus_student");
    const s = state.students.find(x => x.id === sid);
    if (!s) {
      return `
        <div class="card empty">
          <div class="empty-ico">♛</div>
          <div class="empty-title">الطالب غير موجود</div>
          <button class="btn btn-primary" style="margin-top:14px" onclick="window.__app.navigate('students')">العودة للطلاب</button>
        </div>
      `;
    }

    const g = state.groups.find(x => x.id === s.groupId);
    const studentAtt = state.attendance.filter(a => a.studentId === s.id).sort((a,b) => b.date.localeCompare(a.date));
    const studentPay = state.payments.filter(p => p.studentId === s.id).sort((a,b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });
    const studentGrades = state.grades.filter(gr => gr.studentId === s.id);

    const presentDays = studentAtt.filter(a => a.status === "present").length;
    const lateDays = studentAtt.filter(a => a.status === "late").length;
    const absentDays = studentAtt.filter(a => a.status === "absent").length;
    const totalDays = studentAtt.length;
    const attRate = totalDays > 0 ? Math.round((presentDays / totalDays) * 100) : 0;

    const totalPaid = studentPay.filter(p => p.status === "paid").reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const paidMonths = new Set(studentPay.filter(p => p.status === "paid").map(p => p.year + "-" + p.month)).size;

    const avgGrade = studentGrades.length
      ? (studentGrades.reduce((sum, gr) => sum + Number(gr.grade || 0), 0) / studentGrades.length).toFixed(1)
      : "—";

    return `
      <button class="back-btn" data-back-students>← العودة لقائمة الطلاب</button>

      <div class="student-profile">
        <div class="student-avatar">${s.name.charAt(0)}</div>
        <div class="student-info">
          <h2>${escapeHtml(s.name)}</h2>
          <div class="meta">
            ${g ? `<span class="badge primary">${escapeHtml(g.name)}</span>` : '<span class="badge">بدون مجموعة</span>'}
            ${s.discountEnabled ? ` <span class="badge warning">${Number(s.discountedFee) === 0 ? 'إعفاء كامل' : 'خصم مفعل: ' + fmtMoney(s.discountedFee)}</span>` : ''}
            ${s.phone ? ` • ${escapeHtml(s.phone)}` : ''}
            ${s.parentName ? ` • ولي الأمر: ${escapeHtml(s.parentName)}` : ''}
          </div>
        </div>
        <div class="toolbar" style="margin-right:auto">
          <button class="btn btn-secondary" id="studentEditBtn">✏️ تعديل البيانات</button>
          <button class="btn btn-primary" id="studentChartBtn">📊 الرسم البياني</button>
          <button class="btn btn-secondary" id="studentReportBtn">📄 التقرير</button>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-card">
          <h3>📊 نسبة الحضور</h3>
          <div class="value">${attRate}%</div>
          <div class="sub">${presentDays} حاضر • ${lateDays} متأخر • ${absentDays} غائب</div>
        </div>
        <div class="detail-card">
          <h3>💰 إجمالي المدفوعات</h3>
          <div class="value">${fmtMoney(totalPaid)}</div>
          <div class="sub">${paidMonths} شهر مدفوع</div>
        </div>
        <div class="detail-card">
          <h3>⭐ متوسط الدرجات</h3>
          <div class="value">${avgGrade}</div>
          <div class="sub">${studentGrades.length} امتحان</div>
        </div>
      </div>

      <div class="detail-section">
        <h3>📋 سجل الحضور (${studentAtt.length})</h3>
        ${studentAtt.length === 0 ? `
          <div class="empty" style="padding:30px 10px">
            <div class="empty-sub">لا يوجد سجل حضور مسجل</div>
          </div>
        ` : `
          <div class="table-wrap" style="border:none">
            <table>
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>اليوم</th>
                  <th>المجموعة</th>
                  <th>الحالة</th>
                  <th style="text-align:left">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                ${studentAtt.map(a => {
                  const ag = state.groups.find(x => x.id === a.groupId);
                  const d = new Date(a.date + "T00:00:00");
                  const dayName = isNaN(d) ? "—" : AR_DAYS[d.getDay()];
                  const statusBadge = a.status === "present" ? '<span class="badge success">حاضر</span>' :
                                      a.status === "late" ? '<span class="badge warning">متأخر</span>' :
                                      '<span class="badge danger">غائب</span>';
                  return `
                    <tr>
                      <td>${fmtDate(a.date)}</td>
                      <td>${dayName}</td>
                      <td>${ag ? escapeHtml(ag.name) : '<span style="color:var(--text-soft)">—</span>'}</td>
                      <td>${statusBadge}</td>
                      <td>${a.status === "absent" ? `<button class="btn btn-sm btn-whatsapp" data-notify-absence-date="${s.id}|${a.date}" title="إرسال تنبيه غياب لولي الأمر عبر واتساب">📱</button>` : ''}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <div class="detail-section">
        <h3>💳 سجل المدفوعات (${studentPay.length})</h3>
        ${studentPay.length === 0 ? `
          <div class="empty" style="padding:30px 10px">
            <div class="empty-sub">لا يوجد سجل مدفوعات</div>
          </div>
        ` : `
          <div class="table-wrap" style="border:none">
            <table>
              <thead>
                <tr>
                  <th>الشهر</th>
                  <th>المبلغ</th>
                  <th>الحالة</th>
                  <th>تاريخ الدفع</th>
                  <th>ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                ${studentPay.map(p => `
                  <tr>
                    <td>${monthName(p.month)} ${p.year}</td>
                    <td><strong>${fmtMoney(p.amount)}</strong></td>
                    <td>${p.status === "paid" ? '<span class="badge success">مسدد</span>' : '<span class="badge danger">غير مسدد</span>'}</td>
                    <td>${fmtDate(p.paidDate)}</td>
                    <td>${escapeHtml(p.note) || '<span style="color:var(--text-soft)">—</span>'}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <div class="detail-section">
        <h3>📝 درجات الامتحانات (${studentGrades.length})</h3>
        ${studentGrades.length === 0 ? `
          <div class="empty" style="padding:30px 10px">
            <div class="empty-sub">لا يوجد درجات مسجلة</div>
          </div>
        ` : `
          <div class="table-wrap" style="border:none">
            <table>
              <thead>
                <tr>
                  <th>الامتحان</th>
                  <th>المجموعة</th>
                  <th>التاريخ</th>
                  <th>الدرجة</th>
                  <th>النسبة</th>
                  <th>ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                ${studentGrades.map(gr => {
                  const ex = state.exams.find(x => x.id === gr.examId);
                  const pct = ex && ex.maxGrade ? Math.round((gr.grade / ex.maxGrade) * 100) : 0;
                  return `
                    <tr>
                      <td><strong>${ex ? escapeHtml(ex.name) : '—'}</strong></td>
                      <td>${ex ? escapeHtml(state.groups.find(x=>x.id===ex.groupId)?.name || '—') : '—'}</td>
                      <td>${fmtDate(ex?.date)}</td>
                      <td><strong>${gr.grade}</strong> / ${ex ? ex.maxGrade : '—'}</td>
                      <td>
                        <div style="display:flex;align-items:center;gap:8px">
                          <div style="flex:1;height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden">
                            <div style="width:${pct}%;height:100%;background:${pct >= 80 ? 'var(--success)' : pct >= 60 ? 'var(--accent)' : 'var(--danger)'};border-radius:999px"></div>
                          </div>
                          <span style="font-size:12px;font-weight:700;min-width:36px">${pct}%</span>
                        </div>
                      </td>
                      <td>${escapeHtml(gr.note) || '<span style="color:var(--text-soft)">—</span>'}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
  }

  function bindStudentDetail() {
    document.querySelectorAll("[data-back-students]").forEach(el =>
      el.addEventListener("click", () => navigate("students"))
    );
    const editBtn = document.getElementById("studentEditBtn");
    if (editBtn) editBtn.addEventListener("click", () => openStudentForm(sessionStorage.getItem("focus_student")));
    const chartBtn = document.getElementById("studentChartBtn");
    if (chartBtn) chartBtn.addEventListener("click", () => openStudentChart());
    const reportBtn = document.getElementById("studentReportBtn");
    if (reportBtn) reportBtn.addEventListener("click", () => openStudentReport());
    document.querySelectorAll("[data-notify-absence-date]").forEach(el => el.addEventListener("click", () => {
      const [sid, dateIso] = el.dataset.notifyAbsenceDate.split("|");
      openWhatsAppForAbsence(sid, dateIso);
    }));
  }

  /* ---------- Student Chart Modal ---------- */
  function openStudentChart() {
    const sid = sessionStorage.getItem("focus_student");
    const s = state.students.find(x => x.id === sid);
    if (!s) return;

    const studentAtt = state.attendance.filter(a => a.studentId === s.id);
    const studentGrades = state.grades.filter(gr => gr.studentId === s.id);
    const studentPay = state.payments.filter(p => p.studentId === s.id && p.status === "paid");

    openModal("📊 الرسم البياني للطالب: " + s.name, `
      <div style="display:flex;flex-direction:column;gap:20px">
        <div>
          <h4 style="margin-bottom:10px;font-size:14px;color:var(--text-muted)">توزيع الحضور</h4>
          <div class="chart-container" style="height:220px">
            <canvas id="attChart"></canvas>
          </div>
        </div>
        <div>
          <h4 style="margin-bottom:10px;font-size:14px;color:var(--text-muted)">درجات الامتحانات</h4>
          <div class="chart-container" style="height:220px">
            <canvas id="gradesChart"></canvas>
          </div>
        </div>
        <div>
          <h4 style="margin-bottom:10px;font-size:14px;color:var(--text-muted)">المدفوعات الشهرية</h4>
          <div class="chart-container" style="height:220px">
            <canvas id="payChart"></canvas>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-secondary" data-close>إغلاق</button>
      </div>
    `, (root) => {
      // Attendance Pie Chart
      const present = studentAtt.filter(a => a.status === "present").length;
      const late = studentAtt.filter(a => a.status === "late").length;
      const absent = studentAtt.filter(a => a.status === "absent").length;
      if (studentAtt.length > 0) {
        new Chart(root.querySelector("#attChart"), {
          type: "doughnut",
          data: {
            labels: ["حاضر", "متأخر", "غائب"],
            datasets: [{
              data: [present, late, absent],
              backgroundColor: ["#10B981", "#F59E0B", "#EF4444"],
              borderWidth: 0
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: "bottom", labels: { font: { family: "Cairo" } } }
            }
          }
        });
      } else {
        root.querySelector("#attChart").parentElement.innerHTML = '<div style="text-align:center;color:var(--text-soft);padding:40px">لا يوجد بيانات حضور</div>';
      }

      // Grades Bar Chart
      if (studentGrades.length > 0) {
        const examsData = studentGrades.map(gr => {
          const ex = state.exams.find(x => x.id === gr.examId);
          return { name: ex ? ex.name : "—", grade: gr.grade, max: ex ? ex.maxGrade : 100 };
        });
        new Chart(root.querySelector("#gradesChart"), {
          type: "bar",
          data: {
            labels: examsData.map(d => d.name),
            datasets: [
              { label: "الدرجة", data: examsData.map(d => d.grade), backgroundColor: "#0F766E", borderRadius: 6 },
              { label: "الحد الأقصى", data: examsData.map(d => d.max), backgroundColor: "#E5E7EB", borderRadius: 6 }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: "bottom", labels: { font: { family: "Cairo" } } } },
            scales: { y: { beginAtZero: true } }
          }
        });
      } else {
        root.querySelector("#gradesChart").parentElement.innerHTML = '<div style="text-align:center;color:var(--text-soft);padding:40px">لا يوجد درجات</div>';
      }

      // Payments Line Chart
      if (studentPay.length > 0) {
        const payData = studentPay.slice().sort((a,b) => {
          if (a.year !== b.year) return a.year - b.year;
          return a.month - b.month;
        });
        new Chart(root.querySelector("#payChart"), {
          type: "line",
          data: {
            labels: payData.map(p => monthName(p.month) + " " + p.year),
            datasets: [{
              label: "المبلغ (ج.م)",
              data: payData.map(p => p.amount),
              borderColor: "#0F766E",
              backgroundColor: "rgba(15,118,110,0.1)",
              fill: true,
              tension: 0.3,
              pointRadius: 5,
              pointBackgroundColor: "#0F766E"
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: "bottom", labels: { font: { family: "Cairo" } } } },
            scales: { y: { beginAtZero: true } }
          }
        });
      } else {
        root.querySelector("#payChart").parentElement.innerHTML = '<div style="text-align:center;color:var(--text-soft);padding:40px">لا يوجد مدفوعات</div>';
      }
    });
  }

  /* ---------- Student Report Modal ---------- */
  function openStudentReport() {
    const sid = sessionStorage.getItem("focus_student");
    const s = state.students.find(x => x.id === sid);
    if (!s) return;
    const g = state.groups.find(x => x.id === s.groupId);

    const studentAtt = state.attendance.filter(a => a.studentId === s.id).sort((a,b) => b.date.localeCompare(a.date));
    const studentPay = state.payments.filter(p => p.studentId === s.id).sort((a,b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });
    const studentGrades = state.grades.filter(gr => gr.studentId === s.id);

    const presentDays = studentAtt.filter(a => a.status === "present");
    const lateDays = studentAtt.filter(a => a.status === "late");
    const absentDays = studentAtt.filter(a => a.status === "absent");

    const totalPaid = studentPay.filter(p => p.status === "paid").reduce((sum, p) => sum + Number(p.amount || 0), 0);

    openModal("📄 تقرير الطالب: " + s.name, `
      <div class="report-modal-body">
        <div class="report-header">
          <h2>${escapeHtml(s.name)}</h2>
          <p>${g ? escapeHtml(g.name) : 'بدون مجموعة'} ${s.phone ? ' • ' + escapeHtml(s.phone) : ''}</p>
        </div>

        <div class="report-section">
          <h4>📊 ملخص عام</h4>
          <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:0">
            <div class="stat-card success" style="padding:12px"><div class="stat-label">أيام الحضور</div><div class="stat-value" style="font-size:20px">${presentDays.length}</div></div>
            <div class="stat-card accent" style="padding:12px"><div class="stat-label">أيام التأخر</div><div class="stat-value" style="font-size:20px">${lateDays.length}</div></div>
            <div class="stat-card" style="--primary:#EF4444;padding:12px"><div class="stat-label">أيام الغياب</div><div class="stat-value" style="font-size:20px">${absentDays.length}</div></div>
            <div class="stat-card info" style="padding:12px"><div class="stat-label">إجمالي المدفوعات</div><div class="stat-value" style="font-size:20px">${fmtMoney(totalPaid)}</div></div>
          </div>
        </div>

        <div class="report-section">
          <h4>✓ سجل الحضور والغياب</h4>
          ${studentAtt.length === 0 ? '<p style="color:var(--text-soft)">لا يوجد سجل حضور.</p>' : `
            <div class="timeline">
              ${studentAtt.map(a => {
                const d = new Date(a.date + "T00:00:00");
                const dayName = isNaN(d) ? "" : AR_DAYS[d.getDay()];
                const cls = a.status;
                const label = a.status === "present" ? "حاضر" : a.status === "late" ? "متأخر" : "غائب";
                return `
                  <div class="timeline-item ${cls}">
                    <div class="timeline-date">${fmtDate(a.date)}</div>
                    <div class="timeline-label">${label}</div>
                    <div style="margin-right:auto;color:var(--text-soft);font-size:12px">${dayName}</div>
                  </div>
                `;
              }).join("")}
            </div>
          `}
        </div>

        <div class="report-section">
          <h4>💳 سجل المدفوعات</h4>
          ${studentPay.length === 0 ? '<p style="color:var(--text-soft)">لا يوجد سجل مدفوعات.</p>' : `
            <table class="report-table">
              <thead>
                <tr><th>الشهر</th><th>المبلغ</th><th>الحالة</th><th>تاريخ الدفع</th></tr>
              </thead>
              <tbody>
                ${studentPay.map(p => `
                  <tr class="${p.status === 'paid' ? 'paid' : 'unpaid'}">
                    <td>${monthName(p.month)} ${p.year}</td>
                    <td><strong>${fmtMoney(p.amount)}</strong></td>
                    <td>${p.status === "paid" ? '<span class="badge success">مسدد</span>' : '<span class="badge danger">غير مسدد</span>'}</td>
                    <td>${fmtDate(p.paidDate)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          `}
        </div>

        <div class="report-section">
          <h4>📝 درجات الامتحانات</h4>
          ${studentGrades.length === 0 ? '<p style="color:var(--text-soft)">لا يوجد درجات مسجلة.</p>' : `
            <table class="report-table">
              <thead>
                <tr><th>الامتحان</th><th>التاريخ</th><th>الدرجة</th><th>من</th><th>النسبة</th></tr>
              </thead>
              <tbody>
                ${studentGrades.map(gr => {
                  const ex = state.exams.find(x => x.id === gr.examId);
                  const pct = ex && ex.maxGrade ? Math.round((gr.grade / ex.maxGrade) * 100) : 0;
                  return `
                    <tr>
                      <td><strong>${ex ? escapeHtml(ex.name) : '—'}</strong></td>
                      <td>${fmtDate(ex?.date)}</td>
                      <td><strong>${gr.grade}</strong></td>
                      <td>${ex ? ex.maxGrade : '—'}</td>
                      <td><span class="badge ${pct >= 80 ? 'success' : pct >= 60 ? 'warning' : 'danger'}">${pct}%</span></td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          `}
        </div>

        <div style="text-align:center;margin-top:20px;padding-top:14px;border-top:1px dashed var(--border);color:var(--text-soft);font-size:12px">
          تم إنشاء التقرير بتاريخ ${todayLabel()}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-secondary" data-close>إغلاق</button>
        <button class="btn btn-primary" onclick="window.print()">🖨 طباعة التقرير</button>
      </div>
    `);
  }

/* ==========================================================
     EXAMS & GRADES
     ========================================================== */
  function renderExams() {
    if (state.groups.length === 0) {
      return `
        <div class="card empty">
          <div class="empty-ico">★</div>
          <div class="empty-title">لا توجد مجموعات</div>
          <div class="empty-sub">أنشئ مجموعات أولاً</div>
        </div>
      `;
    }
    const focusGroup = sessionStorage.getItem("focus_exam_group") || state.groups[0].id;
    const group = state.groups.find(g => g.id === focusGroup) || state.groups[0];
    const exams = state.exams.filter(e => e.groupId === group.id).sort((a,b) => (b.date||"").localeCompare(a.date||""));
    const focusExam = sessionStorage.getItem("focus_exam") || exams[0]?.id || "";
    const exam = state.exams.find(e => e.id === focusExam) || exams[0];
    const students = state.students.filter(s => s.groupId === group.id);

    return `
      <div class="page-head">
        <h2>${escapeHtml(group.name)}</h2>
        <div class="toolbar">
          <select class="select" id="examGroup" style="min-width:220px">
            ${state.groups.map(g => `<option value="${g.id}" ${g.id===group.id?'selected':''}>${escapeHtml(g.name)}</option>`).join("")}
          </select>
          <button class="btn btn-primary" id="addExam">+ امتحان جديد</button>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card card-pad-lg">
          <div class="page-head" style="margin-bottom:14px">
            <h2>الامتحانات (${exams.length})</h2>
          </div>
          ${exams.length === 0 ? `
            <div class="empty">
              <div class="empty-ico">📝</div>
              <div class="empty-title">لا توجد امتحانات لهذه المجموعة</div>
              <div class="empty-sub">أضف امتحاناً وابدأ تسجيل الدرجات</div>
            </div>
          ` : `
            <div class="dash-list">
              ${exams.map(e => {
                const grades = state.grades.filter(g => g.examId === e.id);
                const avg = grades.length ? (grades.reduce((s,g)=>s+Number(g.grade||0),0) / grades.length) : 0;
                return `
                  <div class="dash-list-item" data-go-exam="${e.id}">
                    <div class="ico">📝</div>
                    <div class="meta">
                      <div class="t">${escapeHtml(e.name)}</div>
                      <div class="s">${fmtDate(e.date)} • من ${e.maxGrade} • ${grades.length}/${students.length} مُصحح</div>
                    </div>
                    <div class="v">${avg.toFixed(1)}</div>
                  </div>
                `;
              }).join("")}
            </div>
          `}
        </div>

        <div class="card card-pad-lg">
          ${!exam ? `
            <div class="empty">
              <div class="empty-ico">★</div>
              <div class="empty-title">اختر امتحاناً من القائمة</div>
            </div>
          ` : (() => {
            const grades = state.grades.filter(g => g.examId === exam.id);
            const recorded = grades.length;
            const avg = recorded ? (grades.reduce((s,g)=>s+Number(g.grade||0),0) / recorded) : 0;
            const max = recorded ? Math.max(...grades.map(g=>Number(g.grade||0))) : 0;
            const min = recorded ? Math.min(...grades.map(g=>Number(g.grade||0))) : 0;
            return `
              <div class="page-head" style="margin-bottom:14px">
                <h2>${escapeHtml(exam.name)}</h2>
                <div class="toolbar">
                  <button class="btn btn-secondary btn-sm" data-edit-exam="${exam.id}">تعديل</button>
                  <button class="btn btn-danger btn-sm" data-del-exam="${exam.id}">حذف</button>
                </div>
              </div>
              <div style="color:var(--text-muted); font-size:13px; margin-bottom:14px">${fmtDate(exam.date)} • الدرجة النهائية ${exam.maxGrade}</div>

              <div class="stat-grid" style="grid-template-columns:repeat(3,1fr); margin-bottom:14px">
                <div class="stat-card success" style="padding:14px"><div class="stat-label">المتوسط</div><div class="stat-value" style="font-size:22px">${avg.toFixed(1)}</div></div>
                <div class="stat-card info" style="padding:14px"><div class="stat-label">أعلى درجة</div><div class="stat-value" style="font-size:22px">${max}</div></div>
                <div class="stat-card accent" style="padding:14px"><div class="stat-label">أقل درجة</div><div class="stat-value" style="font-size:22px">${min}</div></div>
              </div>

              <div class="table-wrap" style="border:none">
                <div style="padding:6px 14px; background:var(--surface-2); border-bottom:1px solid var(--border); display:flex; font-weight:700; font-size:13px; color:var(--text-muted)">
                  <div style="flex:1">الطالب</div>
                  <div style="min-width:200px; text-align:center">الدرجة / ${exam.maxGrade}</div>
                </div>
                ${students.map(s => {
                  const g = grades.find(x => x.studentId === s.id);
                  return `
                    <div class="att-row">
                      <div class="who">${escapeHtml(s.name)}</div>
                      <div style="display:flex; gap:6px; align-items:center">
                        <input class="input grade-input" type="number" min="0" max="${exam.maxGrade}" step="0.5" value="${g ? g.grade : ''}" data-grade="${s.id}" data-exam="${exam.id}" style="width:90px; text-align:center" />
                        <button class="btn btn-primary btn-sm" data-save-grade="${s.id}|${exam.id}">حفظ</button>
                      </div>
                    </div>
                  `;
                }).join("")}
              </div>
            `;
          })()}
        </div>
      </div>
    `;
  }
  function bindExams() {
    const eg = document.getElementById("examGroup");
    if (eg) eg.addEventListener("change", e => {
      sessionStorage.setItem("focus_exam_group", e.target.value);
      sessionStorage.removeItem("focus_exam");
      render();
    });
    const ae = document.getElementById("addExam");
    if (ae) ae.addEventListener("click", () => openExamForm());

    document.querySelectorAll("[data-go-exam]").forEach(el => el.addEventListener("click", () => {
      sessionStorage.setItem("focus_exam", el.dataset.goExam);
      render();
    }));
    document.querySelectorAll("[data-edit-exam]").forEach(el => el.addEventListener("click", () => openExamForm(el.dataset.editExam)));
    document.querySelectorAll("[data-del-exam]").forEach(el => el.addEventListener("click", () => {
      const id = el.dataset.delExam;
      const e = state.exams.find(x => x.id === id);
      if (!e) return;
      if (!confirm(`حذف الامتحان "${e.name}" وكل الدرجات المرتبطة به؟`)) return;
      tx("تم حذف الامتحان", () => {
        state.grades.filter(g => g.examId === id).forEach(g => del("grades", g.id));
        del("exams", id);
      });
      sessionStorage.removeItem("focus_exam");
      render();
    }));
    document.querySelectorAll("[data-save-grade]").forEach(el => el.addEventListener("click", () => {
      const [sid, examId] = el.dataset.saveGrade.split("|");
      const input = document.querySelector(`[data-grade="${sid}"][data-exam="${examId}"]`);
      const exam = state.exams.find(x => x.id === examId);
      if (!exam || !input) return;
      const v = input.value;
      const existing = state.grades.find(g => g.examId === exam.id && g.studentId === sid);
      if (v === "" || v == null) {
        if (existing) tx("تم حذف الدرجة", () => del("grades", existing.id));
        render();
        return;
      }
      let num = Number(v);
      if (isNaN(num)) return toast("قيمة الدرجة غير صحيحة", "danger");
      let wasClamped = false;
      if (num < 0) num = 0;
      if (num > exam.maxGrade) { num = exam.maxGrade; wasClamped = true; }
      const label = wasClamped ? `الدرجة أكبر من الحد الأقصى (${exam.maxGrade}) — تم ضبطها تلقائياً` : "تم حفظ الدرجة";
      tx(label, () => {
        put("grades", {
          id: existing ? existing.id : grId(exam.id, sid),
          examId: exam.id, studentId: sid, grade: num, note: existing ? (existing.note || "") : ""
        });
      }, wasClamped ? "danger" : "success");
      render();
    }));
  }

  /* ==========================================================
     MONTHLY REPORT (overview: who hasn't paid + who's absent a lot)
     ========================================================== */
  const LOW_ATTENDANCE_THRESHOLD = 70; // % — below this is flagged as "high absence"

  function renderMonthlyReport() {
    const t = todayParts();
    const y = Number(sessionStorage.getItem("mrep_y") || t.y);
    const m = Number(sessionStorage.getItem("mrep_m") || t.m);
    let filterGroup = sessionStorage.getItem("mrep_filter_group") || "";
    if (filterGroup && !state.groups.some(g => g.id === filterGroup)) {
      filterGroup = "";
      sessionStorage.removeItem("mrep_filter_group");
    }

    if (state.groups.length === 0) {
      return `
        <div class="card empty">
          <div class="empty-ico">⚠</div>
          <div class="empty-title">لا توجد مجموعات بعد</div>
          <div class="empty-sub">أنشئ مجموعات وأضف طلاباً أولاً لتظهر لك هذه الشاشة</div>
        </div>
      `;
    }

    const monthPrefix = `${y}-${String(m + 1).padStart(2, "0")}`;

    let rows = state.students.filter(s => s.groupId).map(s => {
      const g = state.groups.find(x => x.id === s.groupId);
      const paidAmt = paidTotal(s.id, y, m);
      const dueAmt = getStudentDue(s, g);
      const payStatus = paidAmt >= dueAmt && dueAmt > 0 ? "paid" : paidAmt > 0 ? "partial" : "unpaid";

      const monthAtt = state.attendance.filter(a => a.studentId === s.id && a.date && a.date.startsWith(monthPrefix));
      const presentCount = monthAtt.filter(a => a.status === "present").length;
      const lateCount = monthAtt.filter(a => a.status === "late").length;
      const absentCount = monthAtt.filter(a => a.status === "absent").length;
      const totalRecorded = monthAtt.length;
      const attRate = totalRecorded > 0 ? Math.round(((presentCount + lateCount) / totalRecorded) * 100) : null;

      const paymentProblem = dueAmt > 0 && payStatus !== "paid";
      const attendanceProblem = attRate !== null && attRate < LOW_ATTENDANCE_THRESHOLD;

      return { s, g, dueAmt, paidAmt, payStatus, totalRecorded, absentCount, attRate, paymentProblem, attendanceProblem };
    });

    if (filterGroup) rows = rows.filter(r => r.g.id === filterGroup);

    // Problem rows first, then by name
    rows.sort((a, b) => {
      const score = r => (r.paymentProblem ? 2 : 0) + (r.attendanceProblem ? 1 : 0);
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return a.s.name.localeCompare(b.s.name, "ar");
    });
    lastMonthly = { rows, y, m, filterGroup };

    const unpaidCount = rows.filter(r => r.paymentProblem).length;
    const lowAttCount = rows.filter(r => r.attendanceProblem).length;
    const totalRemaining = rows.reduce((sum, r) => sum + Math.max(0, r.dueAmt - r.paidAmt), 0);
    const bothCount = rows.filter(r => r.paymentProblem && r.attendanceProblem).length;

    return `
      <div class="page-head">
        <h2>${monthName(m)} ${y}</h2>
        <div class="toolbar">
          <select class="select" id="mrepMonth">
            ${AR_MONTHS.map((mn, i) => `<option value="${i}" ${i===m?'selected':''}>${mn}</option>`).join("")}
          </select>
          <select class="select" id="mrepYear">
            ${[y-1, y, y+1].map(yy => `<option value="${yy}" ${yy===y?'selected':''}>${yy}</option>`).join("")}
          </select>
          <select class="select" id="mrepGroupFilter" style="min-width:180px">
            <option value="">كل المجموعات</option>
            ${state.groups.map(g => `<option value="${g.id}" ${filterGroup===g.id?'selected':''}>${escapeHtml(g.name)}</option>`).join("")}
          </select>
          <button class="btn btn-secondary" id="mrepExcel">⬇ Excel</button>
          <button class="btn btn-secondary" id="mrepPdf">🖨 PDF</button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card" style="--primary:#EF4444">
          <div class="stat-label">لسه ما دفعوش (كامل/جزئي)</div>
          <div class="stat-value">${unpaidCount}</div>
          <div class="stat-foot">من ${rows.length} طالب</div>
        </div>
        <div class="stat-card accent">
          <div class="stat-label">غياب مرتفع (أقل من ${LOW_ATTENDANCE_THRESHOLD}%)</div>
          <div class="stat-value">${lowAttCount}</div>
          <div class="stat-foot">خلال ${monthName(m)}</div>
        </div>
        <div class="stat-card" style="--primary:#B91C1C">
          <div class="stat-label">عندهم المشكلتين معاً</div>
          <div class="stat-value">${bothCount}</div>
          <div class="stat-foot">يحتاجوا متابعة عاجلة</div>
        </div>
        <div class="stat-card info">
          <div class="stat-label">إجمالي المتبقي تحصيله</div>
          <div class="stat-value" style="font-size:22px">${fmtMoney(totalRemaining)}</div>
          <div class="stat-foot">لهذا الشهر</div>
        </div>
      </div>

      ${rows.length === 0 ? `
        <div class="card empty">
          <div class="empty-ico">⚠</div>
          <div class="empty-title">لا يوجد طلاب ${filterGroup ? 'في هذه المجموعة' : 'في مجموعات'}</div>
          <div class="empty-sub">${filterGroup ? 'جرّب تغيير الفلتر' : 'أضف طلاباً وعيّنهم لمجموعات أولاً'}</div>
        </div>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>الطالب</th>
                <th>المجموعة</th>
                <th>حالة الدفع</th>
                <th>المتبقي</th>
                <th>نسبة الحضور (الشهر)</th>
                <th>أيام الغياب</th>
                <th style="text-align:left">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const payBadge = r.payStatus === "paid" ? '<span class="badge success">مسدد بالكامل</span>' :
                                  r.payStatus === "partial" ? '<span class="badge warning">دفع جزئي</span>' :
                                  r.dueAmt > 0 ? '<span class="badge danger">غير مسدد</span>' : '<span class="badge success">إعفاء كامل</span>';
                const remaining = Math.max(0, r.dueAmt - r.paidAmt);
                const attCell = r.attRate === null
                  ? '<span style="color:var(--text-soft)">لا يوجد سجل</span>'
                  : `<div style="display:flex;align-items:center;gap:8px">
                       <div style="flex:1;height:6px;background:var(--surface-2);border-radius:999px;overflow:hidden;min-width:60px">
                         <div style="width:${r.attRate}%;height:100%;background:${r.attendanceProblem ? 'var(--danger)' : 'var(--success)'};border-radius:999px"></div>
                       </div>
                       <span class="badge ${r.attendanceProblem ? 'danger' : 'success'}">${r.attRate}%</span>
                     </div>`;
                const rowHighlight = (r.paymentProblem && r.attendanceProblem) ? 'style="background:var(--danger-100)"' : '';
                return `
                  <tr ${rowHighlight}>
                    <td><strong>${escapeHtml(r.s.name)}</strong></td>
                    <td><span class="badge primary">${escapeHtml(r.g?.name || '—')}</span></td>
                    <td>${payBadge}</td>
                    <td>${remaining > 0 ? fmtMoney(remaining) : '<span style="color:var(--success)">✓</span>'}</td>
                    <td>${attCell}</td>
                    <td>${r.absentCount} من ${r.totalRecorded}</td>
                    <td>
                      <div class="table-actions">
                        <button class="btn btn-primary btn-sm" data-view-student-mrep="${r.s.id}">عرض التفاصيل</button>
                        ${remaining > 0 ? `<button class="btn btn-whatsapp btn-sm" data-remind="${r.s.id}|${y}|${m}" title="تذكير ولي الأمر بالمتبقي عبر واتساب">📱 تذكير</button>` : ''}
                      </div>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `}
    `;
  }
  function bindMonthlyReport() {
    const mm = document.getElementById("mrepMonth");
    if (mm) mm.addEventListener("change", e => { sessionStorage.setItem("mrep_m", e.target.value); render(); });
    const my = document.getElementById("mrepYear");
    if (my) my.addEventListener("change", e => { sessionStorage.setItem("mrep_y", e.target.value); render(); });
    const mg = document.getElementById("mrepGroupFilter");
    if (mg) mg.addEventListener("change", e => { sessionStorage.setItem("mrep_filter_group", e.target.value); render(); });
    document.querySelectorAll("[data-view-student-mrep]").forEach(el => el.addEventListener("click", () => {
      sessionStorage.setItem("focus_student", el.dataset.viewStudentMrep);
      navigate("student-detail");
    }));
    const exBtn = document.getElementById("mrepExcel");
    if (exBtn) exBtn.addEventListener("click", exportMonthlyExcel);
    const pdfBtn = document.getElementById("mrepPdf");
    if (pdfBtn) pdfBtn.addEventListener("click", openMonthlyPrint);
    document.querySelectorAll("[data-remind]").forEach(el => el.addEventListener("click", () => {
      const [sid, y, m] = el.dataset.remind.split("|");
      openWhatsAppForDue(sid, Number(y), Number(m));
    }));
  }
  /* ---------- تصدير التقرير الشهري: Excel / PDF ---------- */
  function monthlyExportRows() {
    if (!lastMonthly) return null;
    const { rows, y, m, filterGroup } = lastMonthly;
    const g = state.groups.find(x => x.id === filterGroup);
    const payLabel = { paid: "مسدد بالكامل", partial: "دفع جزئي", unpaid: "غير مسدد" };
    const data = rows.map(r => ({
      name: r.s.name,
      group: r.g ? r.g.name : "—",
      due: r.dueAmt,
      paid: r.paidAmt,
      remaining: Math.max(0, r.dueAmt - r.paidAmt),
      status: r.dueAmt === 0 ? "إعفاء كامل" : payLabel[r.payStatus],
      att: r.attRate,
      absent: r.absentCount,
      recorded: r.totalRecorded,
      parentPhone: r.s.parentPhone || ""
    }));
    return { data, y, m, groupName: g ? g.name : "كل المجموعات" };
  }

  function exportMonthlyExcel() {
    const info = monthlyExportRows();
    if (!info) return;
    if (!window.XLSX) { toast("مكتبة Excel غير محمّلة — تحتاج اتصال بالإنترنت مرة واحدة على الأقل", "danger"); return; }
    const { data, y, m, groupName } = info;
    const header = ["الطالب", "المجموعة", "المستحق", "المدفوع", "المتبقي", "حالة الدفع", "نسبة الحضور %", "أيام الغياب", "أيام مسجلة", "واتساب ولي الأمر"];
    const body = data.map(r => [r.name, r.group, r.due, r.paid, r.remaining, r.status, r.att === null ? "" : r.att, r.absent, r.recorded, r.parentPhone]);
    const total = ["الإجمالي", "", data.reduce((a, r) => a + r.due, 0), data.reduce((a, r) => a + r.paid, 0), data.reduce((a, r) => a + r.remaining, 0), "", "", "", "", ""];
    const ws = XLSX.utils.aoa_to_sheet([[`التقرير الشهري — ${monthName(m)} ${y} — ${groupName}`], [], header, ...body, total]);
    ws["!cols"] = [{ wch: 24 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
    ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }];
    ws["!views"] = [{ RTL: true }];
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, "التقرير الشهري");
    XLSX.writeFile(wb, `monthly-report-${y}-${String(m + 1).padStart(2, "0")}.xlsx`);
    toast("تم تنزيل ملف Excel");
  }

  // PDF: معاينة منسّقة + طباعة (اختار "حفظ كـ PDF" من نافذة الطباعة) — أضمن طريقة للعربي
  function openMonthlyPrint() {
    const info = monthlyExportRows();
    if (!info) return;
    const { data, y, m, groupName } = info;
    const totalDue = data.reduce((a, r) => a + r.due, 0);
    const totalPaid = data.reduce((a, r) => a + r.paid, 0);
    const totalRem = data.reduce((a, r) => a + r.remaining, 0);
    openModal("📄 التقرير الشهري", `
      <div class="report-modal-body">
        <div class="report-header">
          <h2>التقرير الشهري — ${monthName(m)} ${y}</h2>
          <p>${escapeHtml(groupName)} • ${data.length} طالب</p>
        </div>
        <div class="report-section">
          <h4>ملخص</h4>
          <table class="report-table">
            <tbody>
              <tr><th>إجمالي المستحق</th><td>${fmtMoney(totalDue)}</td><th>إجمالي المحصل</th><td>${fmtMoney(totalPaid)}</td><th>المتبقي</th><td>${fmtMoney(totalRem)}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="report-section">
          <h4>تفاصيل الطلاب</h4>
          <table class="report-table">
            <thead><tr><th>الطالب</th><th>المجموعة</th><th>المستحق</th><th>المدفوع</th><th>المتبقي</th><th>الدفع</th><th>الحضور</th><th>الغياب</th></tr></thead>
            <tbody>
              ${data.map(r => `
                <tr>
                  <td><strong>${escapeHtml(r.name)}</strong></td>
                  <td>${escapeHtml(r.group)}</td>
                  <td>${fmtMoney(r.due)}</td>
                  <td>${fmtMoney(r.paid)}</td>
                  <td>${r.remaining > 0 ? fmtMoney(r.remaining) : "✓"}</td>
                  <td>${escapeHtml(r.status)}</td>
                  <td>${r.att === null ? "—" : r.att + "%"}</td>
                  <td>${r.absent} من ${r.recorded}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div style="text-align:center;margin-top:20px;padding-top:14px;border-top:1px dashed var(--border);color:var(--text-soft);font-size:12px">
          تم إنشاء التقرير بتاريخ ${todayLabel()}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-secondary" data-close>إغلاق</button>
        <button class="btn btn-primary" onclick="window.print()">🖨 طباعة / حفظ PDF</button>
      </div>
    `);
    document.querySelector("#modal .modal-card").classList.add("wide");
  }

  /* ---------- نسخ احتياطي / استيراد / مسح ---------- */
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `teacher-data-${todayParts().iso}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("تم تنزيل النسخة الاحتياطية");
  }
  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const n = (data.students || []).length, gc = (data.groups || []).length;
        if (!confirm(`استيراد ${gc} مجموعة و${n} طالب؟\nالاستيراد بيدمج البيانات مع الموجود (ولا يمسح أي حاجة).`)) return;
        const c = importState(data);
        closeModal();
        toast(`تم استيراد ${c} سجل`);
        render();
      } catch (e) {
        toast("فشل قراءة الملف: " + e.message, "danger");
      }
    };
    reader.readAsText(file);
  }
  async function resetData() {
    if (!confirm("سيتم حذف كل البيانات نهائياً من Supabase ومن كل أجهزتك (مجموعات، طلاب، حضور، مدفوعات، درجات). هل أنت متأكد؟")) return;
    if (!confirm("متأكد تماماً؟ هذا الإجراء لا يمكن التراجع عنه — نزّل نسخة احتياطية أولاً لو مش متأكد.")) return;
    if (!sb || !navigator.onLine) { toast("المسح يحتاج اتصال بالإنترنت عشان يتم على السيرفر", "danger"); return; }
    outbox = []; saveOutbox();
    undoStack.length = 0; updateUndoBtn();
    setSync("syncing");
    for (const t of [...TABLES].reverse()) {
      const res = await sb.from(t).delete().neq("id", "");
      const err = withStatus(res);
      if (err) { toast("فشل المسح: " + (err.message || err.code), "danger"); setSync("offline"); return; }
    }
    state = blankState();
    saveCache();
    setSync("ok");
    toast("تم مسح كل البيانات");
    render();
  }

  function openAdvancedSettings() {
    const syncLabel = { ok: "متزامن ✓", syncing: "جاري المزامنة…", offline: "غير متصل", setup: "القاعدة غير مجهزة" }[syncState];
    const counts = `${state.groups.length} مجموعة • ${state.students.length} طالب • ${state.attendance.length} سجل حضور • ${state.payments.length} دفعة`;
    const hasLegacy = !!readLegacy() && !!(readLegacy().students || []).length;

    openModal("⚙ إعدادات متقدمة", `
      <div style="display:flex; flex-direction:column; gap:16px">
        <div class="detail-card" style="padding:14px">
          <h3 style="margin-bottom:6px">☁ المزامنة</h3>
          <p style="color:var(--text-muted); font-size:13px; margin-bottom:10px">الحالة: <strong>${syncLabel}</strong>${outbox.length ? ` • ${outbox.length} تغيير بانتظار الرفع` : ""}<br>${counts}</p>
          <button class="btn btn-primary btn-sm" id="advSyncBtn">⟳ مزامنة الآن</button>
          ${hasLegacy ? `<button class="btn btn-secondary btn-sm" id="advLegacyBtn">⬆ رفع بيانات النسخة القديمة</button>` : ""}
          ${deferredInstall ? `<button class="btn btn-secondary btn-sm" id="advInstallBtn">⬇ تثبيت التطبيق</button>` : ""}
          <p style="color:var(--text-soft); font-size:12px; margin:10px 0 0">لتثبيت التطبيق على iPhone: زرار المشاركة ← "إضافة إلى الشاشة الرئيسية". على أندرويد/كمبيوتر: زرار "تثبيت التطبيق" أعلى الصفحة أو قائمة المتصفح.</p>
        </div>
        <div class="detail-card" style="padding:14px">
          <h3 style="margin-bottom:6px">⬇ تصدير البيانات</h3>
          <p style="color:var(--text-muted); font-size:13px; margin-bottom:10px">تنزيل نسخة احتياطية كاملة (JSON) من كل بياناتك.</p>
          <button class="btn btn-primary btn-sm" id="advExportBtn">⬇ تنزيل نسخة احتياطية</button>
        </div>
        <div class="detail-card" style="padding:14px">
          <h3 style="margin-bottom:6px">⬆ استيراد البيانات</h3>
          <p style="color:var(--text-muted); font-size:13px; margin-bottom:10px">رفع نسخة احتياطية (مثلاً من النسخة القديمة). الاستيراد <strong>بيدمج</strong> مع الموجود ولا يمسح شيئاً.</p>
          <button class="btn btn-secondary btn-sm" id="advImportBtn">⬆ اختيار ملف واستيراد</button>
        </div>
        <div class="detail-card" style="padding:14px; border-color:var(--danger)">
          <h3 style="margin-bottom:6px; color:var(--danger)">✕ مسح كل البيانات</h3>
          <p style="color:var(--text-muted); font-size:13px; margin-bottom:10px">حذف نهائي لكل المجموعات والطلاب والحضور والمدفوعات والدرجات من السيرفر ومن كل الأجهزة.</p>
          <button class="btn btn-danger btn-sm" id="advResetBtn">✕ مسح كل البيانات</button>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-secondary" data-close>إغلاق</button>
      </div>
    `, (root) => {
      root.querySelector("#advSyncBtn").addEventListener("click", () => { syncNow(); toast("جاري المزامنة…", "info"); });
      const lg = root.querySelector("#advLegacyBtn");
      if (lg) lg.addEventListener("click", () => {
        try { const c = importState(readLegacy()); localStorage.setItem(MIGRATED_KEY, "1"); closeModal(); toast(`تم رفع ${c} سجل من البيانات القديمة`); render(); }
        catch (e) { toast("تعذر الرفع: " + e.message, "danger"); }
      });
      const ib = root.querySelector("#advInstallBtn");
      if (ib) ib.addEventListener("click", installApp);
      root.querySelector("#advExportBtn").addEventListener("click", exportData);
      root.querySelector("#advImportBtn").addEventListener("click", () => document.getElementById("importFile").click());
      root.querySelector("#advResetBtn").addEventListener("click", () => { closeModal(); resetData(); });
    });
  }

  function installApp() {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    deferredInstall.userChoice.finally(() => {
      deferredInstall = null;
      const b = document.getElementById("installBtn");
      if (b) b.hidden = true;
    });
  }

  document.getElementById("advancedSettingsBtn").addEventListener("click", openAdvancedSettings);
  document.getElementById("mobileSettings").addEventListener("click", openAdvancedSettings);
  document.getElementById("importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("syncPill").addEventListener("click", () => { if (syncState === "setup") syncState = "offline"; updateBanner(); syncNow(); toast("جاري المزامنة…", "info"); });
  document.getElementById("installBtn").addEventListener("click", installApp);
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    document.getElementById("installBtn").hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    document.getElementById("installBtn").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "")) {
      e.preventDefault();
      undo();
    }
  });

  /* ==========================================================
     INIT
     ========================================================== */
  document.getElementById("todayLabel").textContent = todayLabel();
  updateUndoBtn();
  updateSyncUI();
  navigate("dashboard");
  startSync();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW registration failed", err));
    });
  }

  // Expose for inline handlers (e.g., onclick in empty states)
  window.__app = { navigate, get state() { return state; } };
})();