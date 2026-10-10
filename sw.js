/* Service Worker — يخلي التطبيق يفتح بدون إنترنت.
   - ملفات التطبيق: الشبكة أولاً (عشان التحديثات توصل فورًا) ثم الكاش لو أوفلاين.
   - المكتبات والخطوط من CDN: الكاش أولاً.
   - طلبات Supabase: لا تمر على الكاش أبدًا (المزامنة تتولاها app.js). */
const VERSION = "v4.0.0";
const CORE = `tgm-core-${VERSION}`;
const RUNTIME = `tgm-rt-${VERSION}`;

const CORE_FILES = [
  "./", "index.html", "styles.css", "app.js", "manifest.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"
];
const CDN_FILES = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE);
    await core.addAll(CORE_FILES);
    const rt = await caches.open(RUNTIME);
    await Promise.all(CDN_FILES.map(u => rt.add(new Request(u, { mode: "cors" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CORE && k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname.endsWith("supabase.co") || url.hostname.endsWith("supabase.in")) return;

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) { const c = await caches.open(CORE); c.put(req, res.clone()); }
        return res;
      } catch (e) {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === "navigate") return (await caches.match("index.html")) || (await caches.match("./"));
        throw e;
      }
    })());
    return;
  }

  // CDN / خطوط: الكاش أولاً
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res && (res.ok || res.type === "opaque")) { const c = await caches.open(RUNTIME); c.put(req, res.clone()); }
      return res;
    } catch (e) {
      return new Response("", { status: 504, statusText: "offline" });
    }
  })());
});
