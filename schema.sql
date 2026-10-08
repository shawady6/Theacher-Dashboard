-- =====================================================================
--  إدارة المجموعات الدراسية — إعداد قاعدة بيانات Supabase
--  شغّل هذا الملف كاملًا مرة واحدة: Supabase ← SQL Editor ← New query ← Run
--  آمن لو اتشغّل أكتر من مرة (لا يمسح بيانات).
--  ملاحظة: التطبيق بدون تسجيل دخول، فالسياسات مفتوحة لمفتاح anon.
--  أي شخص يعرف رابط الموقع يقدر يقرأ/يعدّل/يمسح البيانات.
-- =====================================================================

-- ---------- الجداول ----------
create table if not exists public.groups (
  id             text primary key,
  name           text not null,
  monthly_fee    numeric not null default 0,
  schedule       jsonb not null default '[]'::jsonb,      -- أيام الأسبوع 0=الأحد..6=السبت
  schedule_times jsonb not null default '{}'::jsonb,      -- { "6": "17:00", ... }
  notes          text default '',
  created_at     bigint
);

create table if not exists public.students (
  id               text primary key,
  name             text not null,
  phone            text default '',
  parent_name      text default '',
  parent_phone     text default '',
  group_id         text references public.groups(id) on delete set null,
  notes            text default '',
  discount_enabled boolean not null default false,
  discounted_fee   numeric,
  joined_at        bigint
);

create table if not exists public.attendance (
  id         text primary key,
  student_id text not null references public.students(id) on delete cascade,
  group_id   text references public.groups(id) on delete set null,
  date       date not null,
  status     text not null check (status in ('present','late','absent'))
);
-- سجل حضور واحد لكل (طالب + مجموعة + تاريخ)
create unique index if not exists attendance_unique on public.attendance (student_id, group_id, date);
create index if not exists attendance_date_idx on public.attendance (date);

create table if not exists public.payments (
  id         text primary key,
  student_id text not null references public.students(id) on delete cascade,
  group_id   text references public.groups(id) on delete set null,
  year       int  not null,
  month      int  not null check (month between 0 and 11),   -- 0=يناير .. 11=ديسمبر (زي التطبيق)
  amount     numeric not null,
  status     text not null default 'paid',
  paid_date  date,
  note       text default '',
  created_at bigint
);
-- كل دفعة سجل مستقل (يمكن أكثر من دفعة لنفس الطالب في نفس الشهر)
create index if not exists payments_student_period_idx on public.payments (student_id, year, month);

create table if not exists public.exams (
  id         text primary key,
  name       text not null,
  group_id   text not null references public.groups(id) on delete cascade,
  date       date,
  max_grade  numeric not null default 50,
  created_at bigint
);

create table if not exists public.grades (
  id         text primary key,
  exam_id    text not null references public.exams(id) on delete cascade,
  student_id text not null references public.students(id) on delete cascade,
  grade      numeric not null,
  note       text default '',
  unique (exam_id, student_id)
);

-- ---------- الصلاحيات (بدون تسجيل دخول) ----------
grant usage on schema public to anon, authenticated;
grant all on public.groups, public.students, public.attendance, public.payments, public.exams, public.grades
  to anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['groups','students','attendance','payments','exams','grades'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "open_access" on public.%I', t);
    execute format('create policy "open_access" on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ---------- المزامنة اللحظية بين الأجهزة (Realtime) ----------
do $$
declare t text;
begin
  foreach t in array array['groups','students','attendance','payments','exams','grades'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
