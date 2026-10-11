# Practice Platform (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy the Phase 1 private-psychologist practice platform: booking, consent, clinical notes, invoicing with PayFast, manual and medical-aid payments, reminders, reports and audit, with database-enforced access control.

**Architecture:** One Next.js (App Router, TypeScript) app on Vercel serves staff workspace (`/app`), patient portal (`/portal`) and public booking (`/book`). Supabase Postgres holds all data; row-level security plus triggers and constraints enforce access, immutability, double-booking prevention and payment integrity. Server actions and route handlers re-check authorisation; the service-role key is used only for webhooks, cron and audit writes.

**Tech Stack:** Next.js 15, React 19, TypeScript, Tailwind CSS, Radix UI, Zod, Supabase (Postgres, Auth with TOTP MFA, Storage, pg_cron), `@supabase/ssr`, Vitest, `pg` (for DB tests), Playwright, Supabase CLI, Vercel CLI.

**Spec:** `docs/superpowers/specs/2026-10-11-psychologist-practice-platform-design.md`

All paths below are relative to the repo root `practice-platform/` (created in Task 1; remote `https://github.com/H2OBelowZero/practice-platform.git`).

## Global Constraints

- Money is integer cents in ZAR; display as `R 1 234,50`.
- Practice timezone is `Africa/Johannesburg` (UTC+2, no DST); store `timestamptz`.
- Only the `psychologist` role can read `clinical_notes`. Admin and bookkeeper get zero rows.
- ICD-10 codes on claims are invisible to the bookkeeper and to patients.
- Signed notes are immutable; corrections are rows in `note_addenda`.
- An invoice becomes paid only via a verified `payments` row (PayFast ITN verified server-to-server, or a manual/medical-aid payment recorded by an authorised user). Claim status never changes paid state on its own.
- `payments.gateway_ref` is unique when present, so duplicate notifications are no-ops.
- Overlapping `confirmed` or `tentative` appointments are rejected by an exclusion constraint.
- Reminders and notifications contain no clinical content: date, time and portal link only.
- `audit_log` is insert-only for every role.
- Staff must pass TOTP MFA (aal2) before any `/app` route renders.
- No secrets and no real patient data in the repo. Seed data is fictional.
- Colour is never the only status indicator; keyboard and screen-reader support required.
- No automatic record deletion.

## Review Focus

1. Two requests booking the same slot at the same instant: exactly one succeeds, the other gets a "slot taken" message.
2. A patient edits a URL or request id to another patient's appointment, invoice or form: zero rows, 404 in the UI.
3. PayFast ITN replayed, with a wrong amount, or with a bad signature: no balance change.
4. Patient pays online while a medical-aid remittance arrives: the balance never goes negative and over-payment is rejected.
5. Booking near midnight or across month boundaries in SAST: slots fall on the correct local day.

---

## File Structure

```
app/(public)/book/…            public booking journey
app/(auth)/login, mfa, recover
app/app/…                      staff workspace (dashboard, calendar, patients, notes, billing, claims, reports, tasks, settings)
app/portal/…                   patient portal
app/api/payfast/itn/route.ts   ITN webhook
app/api/cron/reminders/route.ts
lib/supabase/{server,client,service}.ts
lib/auth/session.ts            requireRole, requireStaffMfa
lib/audit.ts
lib/money.ts
lib/booking/slots.ts           pure slot engine
lib/booking/policy.ts          cancellation policy (pure)
lib/payments/payfast.ts        signature + ITN verification
lib/billing/invoice.ts         invoice totals (pure)
supabase/migrations/*.sql
supabase/seed.sql
tests/db/*.test.ts             RLS and trigger tests
tests/unit/*.test.ts
tests/e2e/*.spec.ts
```

---

### Task 1: Repository scaffold and remote

**Files:**
- Create: whole project skeleton in `practice-platform/`, `.gitignore`, `.env.example`, `vitest.config.ts`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Produces: `npm run test:unit`, `npm run test:db`, `npm run typecheck`, `npm run lint`; env vars listed in `.env.example`.

- [ ] **Step 1: Scaffold**

Run (PowerShell, from `C:\Users\User\Documents\Business & Work`):
```powershell
npx create-next-app@latest practice-platform --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm
cd practice-platform
npm i @supabase/supabase-js @supabase/ssr zod @radix-ui/react-dialog @radix-ui/react-tabs @radix-ui/react-select
npm i -D vitest pg @types/pg @playwright/test supabase dotenv
```

- [ ] **Step 2: Scripts and env template**

In `package.json` set scripts: `"typecheck": "tsc --noEmit"`, `"test:unit": "vitest run tests/unit"`, `"test:db": "vitest run tests/db --no-file-parallelism"`, `"test:e2e": "playwright test"`.

`.env.example`:
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL_TEST=postgresql://postgres:postgres@127.0.0.1:54322/postgres
PAYFAST_MERCHANT_ID=
PAYFAST_MERCHANT_KEY=
PAYFAST_PASSPHRASE=
PAYFAST_SANDBOX=true
CRON_SECRET=
EMAIL_API_KEY=
APP_URL=http://localhost:3000
```
`.gitignore` must include `.env*` except `.env.example`.

- [ ] **Step 3: vitest config**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  test: { environment: "node", setupFiles: ["dotenv/config"] },
  resolve: { alias: { "@": path.resolve(__dirname) } },
});
```

- [ ] **Step 4: CI**

`.github/workflows/ci.yml`: on push/PR run `npm ci`, `npm run typecheck`, `npm run lint`, `npm run test:unit`, then `npx supabase start` and `npm run test:db`.

- [ ] **Step 5: Init git, connect remote, first push**

```powershell
git init -b main
git add .
git commit -m "chore: scaffold Next.js app"
git remote add origin https://github.com/H2OBelowZero/practice-platform.git
git push -u origin main
```
Expected: push succeeds to the owner-approved repo. If the remote already has commits, stop and ask the owner before pushing.

---

### Task 2: Core schema (people, practice, patients, audit)

**Files:**
- Create: `supabase/migrations/0001_core.sql`, `tests/db/helpers.ts`, `tests/db/core.test.ts`

**Interfaces:**
- Produces SQL functions used by all RLS policies: `auth_role() returns role_t`, `is_staff() returns boolean`, `my_patient_ids() returns setof uuid`, `audit_write(action text, entity text, entity_id uuid, detail jsonb)`.
- Produces test helper `asUser(sub: string, fn: (q) => Promise<T>): Promise<T>` and `asService(fn)`.

- [ ] **Step 1: Write the test helper**

```ts
// tests/db/helpers.ts
import { Client } from "pg";
export async function withClient<T>(fn: (c: Client) => Promise<T>) {
  const c = new Client({ connectionString: process.env.DATABASE_URL_TEST });
  await c.connect();
  try { await c.query("begin"); return await fn(c); }
  finally { await c.query("rollback"); await c.end(); }
}
/** run queries as an authenticated Supabase user inside a rolled-back transaction */
export async function asUser<T>(c: Client, sub: string, fn: () => Promise<T>) {
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role: "authenticated" })]);
  try { return await fn(); } finally { await c.query("reset role"); }
}
export async function mkUser(c: Client, role: string, name = role) {
  const { rows } = await c.query(
    "insert into auth.users(id,email,instance_id,aud,role) values (gen_random_uuid(), $1||'@t.test', '00000000-0000-0000-0000-000000000000','authenticated','authenticated') returning id",
    [name + Math.random().toString(36).slice(2)]);
  await c.query("insert into profiles(user_id,role,display_name) values ($1,$2,$3)", [rows[0].id, role, name]);
  return rows[0].id as string;
}
```

- [ ] **Step 2: Write failing test**

```ts
// tests/db/core.test.ts
import { it, expect } from "vitest";
import { withClient, asUser, mkUser } from "./helpers";

it("audit_log cannot be updated or deleted by anyone", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist");
  await c.query("insert into audit_log(actor_id,action,entity) values ($1,'x','y')", [psy]);
  await asUser(c, psy, async () => {
    await expect(c.query("update audit_log set action='z'")).rejects.toThrow();
    await expect(c.query("delete from audit_log")).rejects.toThrow();
  });
}));

it("a patient sees only their own patient row", () => withClient(async (c) => {
  const u1 = await mkUser(c, "patient"); const u2 = await mkUser(c, "patient");
  await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','One'),($2,'B','Two')", [u1, u2]);
  const rows = await asUser(c, u1, async () => (await c.query("select last_name from patients")).rows);
  expect(rows).toEqual([{ last_name: "One" }]);
}));
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx supabase start; npm run test:db`
Expected: FAIL (tables missing).

- [ ] **Step 4: Write migration**

```sql
-- supabase/migrations/0001_core.sql
create extension if not exists btree_gist;
create type role_t as enum ('psychologist','admin','bookkeeper','patient','guardian','associate');

create table practices (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Practice',
  registration_no text, hpcsa_no text,
  timezone text not null default 'Africa/Johannesburg',
  approval_mode text not null default 'request' check (approval_mode in ('auto','request')),
  cancellation_window_hours int not null default 24,
  late_cancel_fee_cents int not null default 0,
  vat_registered boolean not null default false, vat_rate numeric(5,2) not null default 15,
  crisis_text text not null default 'If you are in crisis call SADAG 0800 567 567 or go to the nearest emergency room. This platform is not an emergency service.',
  created_at timestamptz not null default now());
insert into practices default values;

create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  role role_t not null, display_name text not null, created_at timestamptz not null default now());

create table patients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete set null,
  patient_number serial,
  first_name text not null, last_name text not null, date_of_birth date,
  email text, phone text, language text default 'en',
  comms_prefs jsonb not null default '{"email":true,"sms":false}',
  emergency_contact jsonb, referral_source text, payer text default 'self',
  status text not null default 'prospect' check (status in ('prospect','active','archived')),
  is_minor boolean not null default false,
  created_at timestamptz not null default now());

create table guardianships (
  id uuid primary key default gen_random_uuid(),
  guardian_user_id uuid not null references auth.users on delete cascade,
  patient_id uuid not null references patients on delete cascade,
  permissions jsonb not null default '{"book":true,"forms":true,"pay":true}',
  authority_note text, valid_from date not null default current_date, valid_to date);

create table audit_log (
  id bigserial primary key, actor_id uuid, role text, action text not null,
  entity text, entity_id uuid, detail jsonb, at timestamptz not null default now());

create function auth_role() returns role_t language sql stable security definer set search_path=public as
$$ select role from profiles where user_id = auth.uid() $$;
create function is_staff() returns boolean language sql stable security definer set search_path=public as
$$ select coalesce(auth_role() in ('psychologist','admin','bookkeeper','associate'), false) $$;
create function my_patient_ids() returns setof uuid language sql stable security definer set search_path=public as
$$ select id from patients where user_id = auth.uid()
   union select patient_id from guardianships
     where guardian_user_id = auth.uid() and valid_from <= current_date and (valid_to is null or valid_to >= current_date) $$;

alter table practices enable row level security;
alter table profiles enable row level security;
alter table patients enable row level security;
alter table guardianships enable row level security;
alter table audit_log enable row level security;

create policy practices_read on practices for select to authenticated using (true);
create policy practices_write on practices for update to authenticated using (auth_role() in ('psychologist')) ;
create policy profiles_self on profiles for select to authenticated using (user_id = auth.uid() or is_staff());
create policy patients_staff_read on patients for select to authenticated using (auth_role() in ('psychologist','admin','associate'));
create policy patients_staff_write on patients for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy patients_own on patients for select to authenticated using (id in (select my_patient_ids()));
create policy patients_own_update on patients for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy guardianship_read on guardianships for select to authenticated using (guardian_user_id = auth.uid() or auth_role() in ('psychologist','admin'));
create policy audit_read on audit_log for select to authenticated using (auth_role() = 'psychologist');
create policy audit_insert on audit_log for insert to authenticated with check (actor_id = auth.uid());
-- no update/delete policies: audit_log is append-only
revoke update, delete on audit_log from authenticated, anon;

create function audit_write(p_action text, p_entity text, p_entity_id uuid, p_detail jsonb default null) returns void
language sql security definer set search_path=public as
$$ insert into audit_log(actor_id,role,action,entity,entity_id,detail) values (auth.uid(), auth_role()::text, p_action, p_entity, p_entity_id, p_detail) $$;
```

- [ ] **Step 5: Reset and run**

Run: `npx supabase db reset; npm run test:db`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add supabase tests && git commit -m "feat(db): core schema, roles, audit log"
```

---

### Task 3: Booking schema with double-booking constraint

**Files:**
- Create: `supabase/migrations/0002_booking.sql`, `tests/db/booking.test.ts`

**Interfaces:**
- Consumes: Task 2 helpers.
- Produces tables `session_types`, `availability_rules`, `blocked_times`, `appointments`, `appointment_events`; SQL function `book_appointment(p_patient uuid, p_type uuid, p_start timestamptz) returns uuid` (raises `slot_taken` on overlap).

- [ ] **Step 1: Failing test**

```ts
// tests/db/booking.test.ts
import { it, expect } from "vitest";
import { withClient, mkUser } from "./helpers";

async function seed(c: any) {
  const psy = await mkUser(c, "psychologist");
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('Therapy',50,95000) returning id")).rows[0].id;
  const p = (await c.query("insert into patients(first_name,last_name) values ('A','B') returning id")).rows[0].id;
  return { psy, t, p };
}
it("rejects overlapping confirmed appointments", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  await c.query("select book_appointment($1,$2,'2030-01-07T08:00:00Z')", [p, t]);
  await expect(c.query("select book_appointment($1,$2,'2030-01-07T08:30:00Z')", [p, t])).rejects.toThrow(/slot_taken/);
}));
it("allows a cancelled slot to be rebooked and records events", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  const id = (await c.query("select book_appointment($1,$2,'2030-01-07T08:00:00Z') id", [p, t])).rows[0].id;
  await c.query("update appointments set status='cancelled' where id=$1", [id]);
  await c.query("select book_appointment($1,$2,'2030-01-07T08:00:00Z')", [p, t]);
  const ev = await c.query("select event from appointment_events where appointment_id=$1 order by id", [id]);
  expect(ev.rows.map((r: any) => r.event)).toEqual(["created", "status:cancelled"]);
}));
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npm run test:db -- booking` → FAIL (relation missing).

- [ ] **Step 3: Migration**

```sql
-- supabase/migrations/0002_booking.sql
create table session_types (
  id uuid primary key default gen_random_uuid(), name text not null,
  duration_min int not null check (duration_min > 0), fee_cents int not null check (fee_cents >= 0),
  format text not null default 'in_person' check (format in ('in_person','video')),
  buffer_min int not null default 10, deposit_cents int not null default 0, active boolean not null default true);
create table availability_rules (
  id uuid primary key default gen_random_uuid(), weekday int not null check (weekday between 0 and 6),
  start_time time not null, end_time time not null check (end_time > start_time));
create table blocked_times (
  id uuid primary key default gen_random_uuid(), starts_at timestamptz not null, ends_at timestamptz not null check (ends_at > starts_at), reason text);
create table appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients, session_type_id uuid not null references session_types,
  starts_at timestamptz not null, ends_at timestamptz not null check (ends_at > starts_at),
  status text not null default 'confirmed' check (status in ('requested','tentative','confirmed','attended','no_show','cancelled')),
  cancelled_by uuid, cancel_reason text, created_at timestamptz not null default now(),
  constraint no_overlap exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&)
    where (status in ('tentative','confirmed')));
create table appointment_events (
  id bigserial primary key, appointment_id uuid not null references appointments on delete cascade,
  event text not null, actor uuid, detail jsonb, at timestamptz not null default now());

create function appt_events() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op = 'INSERT' then insert into appointment_events(appointment_id,event,actor) values (new.id,'created',auth.uid());
  elsif new.status is distinct from old.status then insert into appointment_events(appointment_id,event,actor) values (new.id,'status:'||new.status,auth.uid());
  elsif new.starts_at is distinct from old.starts_at then insert into appointment_events(appointment_id,event,actor,detail) values (new.id,'rescheduled',auth.uid(),jsonb_build_object('from',old.starts_at,'to',new.starts_at));
  end if; return new; end $$;
create trigger trg_appt_events after insert or update on appointments for each row execute function appt_events();

create function book_appointment(p_patient uuid, p_type uuid, p_start timestamptz, p_status text default 'confirmed') returns uuid
language plpgsql security definer set search_path=public as $$
declare dur int; new_id uuid;
begin
  select duration_min into dur from session_types where id = p_type and active;
  if dur is null then raise exception 'unknown_session_type'; end if;
  begin
    insert into appointments(patient_id,session_type_id,starts_at,ends_at,status)
    values (p_patient,p_type,p_start,p_start + make_interval(mins => dur),p_status) returning id into new_id;
  exception when exclusion_violation then raise exception 'slot_taken';
  end;
  return new_id; end $$;

alter table session_types enable row level security; alter table availability_rules enable row level security;
alter table blocked_times enable row level security; alter table appointments enable row level security;
alter table appointment_events enable row level security;
create policy st_read on session_types for select using (true);
create policy st_write on session_types for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
create policy ar_read on availability_rules for select using (true);
create policy ar_write on availability_rules for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
create policy bt_staff on blocked_times for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy ap_staff on appointments for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy ap_own on appointments for select to authenticated using (patient_id in (select my_patient_ids()));
create policy ae_staff on appointment_events for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy ae_own on appointment_events for select to authenticated using (appointment_id in (select id from appointments where patient_id in (select my_patient_ids())));
-- public slot availability is computed server-side from a security-definer view of busy ranges only (no patient data)
create function busy_ranges(p_from timestamptz, p_to timestamptz) returns table(starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path=public as $$
  select starts_at, ends_at from appointments where status in ('tentative','confirmed') and starts_at < p_to and ends_at > p_from
  union all select starts_at, ends_at from blocked_times where starts_at < p_to and ends_at > p_from $$;
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx supabase db reset; npm run test:db -- booking` → PASS.

- [ ] **Step 5: Commit** `git commit -am "feat(db): booking schema with overlap exclusion"`

---

### Task 4: Clinical notes with immutability, plus isolation tests

**Files:**
- Create: `supabase/migrations/0003_notes.sql`, `tests/db/notes.test.ts`

**Interfaces:**
- Produces tables `note_templates`, `clinical_notes`, `note_versions`, `note_addenda`; function `sign_note(p_note uuid) returns void`; function `add_addendum(p_note uuid, p_content text) returns void`.

- [ ] **Step 1: Failing tests**

```ts
// tests/db/notes.test.ts
import { it, expect } from "vitest";
import { withClient, asUser, mkUser } from "./helpers";

async function mk(c: any) {
  const psy = await mkUser(c, "psychologist"); const adm = await mkUser(c, "admin");
  const bk = await mkUser(c, "bookkeeper"); const pu = await mkUser(c, "patient");
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'P','Q') returning id", [pu])).rows[0].id;
  const n = (await c.query("insert into clinical_notes(patient_id,author_id,content) values ($1,$2,'{\"s\":\"x\"}') returning id", [p, psy])).rows[0].id;
  return { psy, adm, bk, pu, n };
}
it("only the psychologist can read notes", () => withClient(async (c) => {
  const { psy, adm, bk, pu } = await mk(c);
  for (const [u, expected] of [[psy, 1], [adm, 0], [bk, 0], [pu, 0]] as const) {
    const r = await asUser(c, u, async () => (await c.query("select id from clinical_notes")).rowCount);
    expect(r).toBe(expected);
  }
}));
it("signed notes cannot be edited or deleted; addenda allowed", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  await asUser(c, psy, async () => {
    await c.query("select sign_note($1)", [n]);
    await expect(c.query("update clinical_notes set content='{\"s\":\"changed\"}' where id=$1", [n])).rejects.toThrow(/immutable/);
    await expect(c.query("delete from clinical_notes where id=$1", [n])).rejects.toThrow(/immutable/);
    await c.query("select add_addendum($1,'late correction')", [n]);
    const s = (await c.query("select state from clinical_notes where id=$1", [n])).rows[0].state;
    expect(s).toBe("amended");
  });
}));
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Migration**

```sql
-- supabase/migrations/0003_notes.sql
create table note_templates (id uuid primary key default gen_random_uuid(), name text not null, schema jsonb not null, active boolean default true);
insert into note_templates(name,schema) values
 ('SOAP','{"fields":["subjective","objective","assessment","plan"]}'),
 ('DAP','{"fields":["data","assessment","plan"]}'),
 ('Free form','{"fields":["notes"]}');
create table clinical_notes (
  id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  appointment_id uuid references appointments, template_id uuid references note_templates,
  state text not null default 'draft' check (state in ('draft','signed','amended')),
  content jsonb not null default '{}', risk jsonb not null default '{}',
  author_id uuid not null, signed_at timestamptz, created_at timestamptz not null default now());
create table note_versions (id bigserial primary key, note_id uuid not null references clinical_notes on delete cascade,
  version_no int not null, content jsonb not null, saved_by uuid, saved_at timestamptz not null default now());
create table note_addenda (id uuid primary key default gen_random_uuid(), note_id uuid not null references clinical_notes,
  content text not null, author_id uuid not null, created_at timestamptz not null default now());

create function notes_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.state <> 'draft' then raise exception 'note is immutable'; end if; return old; end if;
  if old.state <> 'draft' and (new.content is distinct from old.content or new.risk is distinct from old.risk
      or new.patient_id <> old.patient_id or new.author_id <> old.author_id or new.signed_at is distinct from old.signed_at) then
    raise exception 'note is immutable'; end if;
  if old.state = 'draft' and new.content is distinct from old.content then
    insert into note_versions(note_id,version_no,content,saved_by)
    select old.id, coalesce(max(version_no),0)+1, old.content, auth.uid() from note_versions where note_id = old.id; end if;
  return new; end $$;
create trigger trg_notes_guard before update or delete on clinical_notes for each row execute function notes_guard();

create function sign_note(p_note uuid) returns void language plpgsql security invoker as $$
begin
  update clinical_notes set state='signed', signed_at=now() where id=p_note and state='draft';
  if not found then raise exception 'note not draftable'; end if;
  perform audit_write('note.sign','clinical_notes',p_note); end $$;
create function add_addendum(p_note uuid, p_content text) returns void language plpgsql security invoker as $$
begin
  insert into note_addenda(note_id,content,author_id) values (p_note,p_content,auth.uid());
  update clinical_notes set state='amended' where id=p_note and state in ('signed','amended');
  perform audit_write('note.addendum','clinical_notes',p_note); end $$;

alter table note_templates enable row level security; alter table clinical_notes enable row level security;
alter table note_versions enable row level security; alter table note_addenda enable row level security;
create policy nt_read on note_templates for select to authenticated using (is_staff());
create policy cn_psy on clinical_notes for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist' and author_id = auth.uid());
create policy nv_psy on note_versions for select to authenticated using (auth_role()='psychologist');
create policy na_psy on note_addenda for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
```
Note: `audit_write` runs `security definer`, and the trigger's `auth.uid()` reads the caller's claims, so the audit actor is correct.

- [ ] **Step 4: Run, expect PASS.** `npx supabase db reset; npm run test:db -- notes`

- [ ] **Step 5: Commit** `git commit -am "feat(db): clinical notes with immutability and addenda"`

---

### Task 5: Forms, consents, tasks, outbox schema

**Files:**
- Create: `supabase/migrations/0004_forms_tasks.sql`, `tests/db/forms.test.ts`

**Interfaces:**
- Produces tables `form_templates(key, version, schema, active)`, `form_submissions`, `consents`, `tasks`, `notifications_outbox`, `retention_policies`.
- Produces function `set_consent(p_patient uuid, p_purpose text, p_granted boolean, p_submission uuid) returns void` which, when withdrawing, inserts a task for the psychologist.

- [ ] **Step 1: Failing test** (patient reads only own submissions; withdrawal creates a task)

```ts
// tests/db/forms.test.ts
import { it, expect } from "vitest";
import { withClient, asUser, mkUser } from "./helpers";
it("patient sees only own submissions", () => withClient(async (c) => {
  const u1 = await mkUser(c, "patient"), u2 = await mkUser(c, "patient");
  const p1 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u1])).rows[0].id;
  const p2 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','B') returning id", [u2])).rows[0].id;
  const t = (await c.query("insert into form_templates(key,version,schema) values ('reg',1,'{}') returning id")).rows[0].id;
  await c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$3,1),($2,$3,1)", [p1, p2, t]);
  const n = await asUser(c, u1, async () => (await c.query("select 1 from form_submissions")).rowCount);
  expect(n).toBe(1);
}));
it("withdrawing consent creates a task", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist"); const u = await mkUser(c, "patient");
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u])).rows[0].id;
  await asUser(c, u, async () => { await c.query("select set_consent($1,'telehealth',true,null)", [p]); await c.query("select set_consent($1,'telehealth',false,null)", [p]); });
  const t = await c.query("select 1 from tasks where patient_id=$1 and source='consent_withdrawn'", [p]);
  expect(t.rowCount).toBe(1);
}));
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Migration**

```sql
-- supabase/migrations/0004_forms_tasks.sql
create table form_templates (id uuid primary key default gen_random_uuid(), key text not null, version int not null, schema jsonb not null, active boolean not null default true, unique(key,version));
create table form_submissions (id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  template_id uuid not null references form_templates, template_version int not null, answers jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft','submitted','returned')), submitted_at timestamptz, updated_at timestamptz not null default now());
create table consents (id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  purpose text not null check (purpose in ('treatment','privacy_notice','telehealth','financial_terms','share_referrer','share_insurer')),
  granted boolean not null, granted_at timestamptz, withdrawn_at timestamptz, form_submission_id uuid references form_submissions, template_version int,
  unique(patient_id,purpose));
create table tasks (id uuid primary key default gen_random_uuid(), title text not null, due_at timestamptz, priority text not null default 'normal' check (priority in ('low','normal','high')),
  status text not null default 'open' check (status in ('open','done')), assignee uuid references auth.users, patient_id uuid references patients,
  appointment_id uuid references appointments, source text, created_at timestamptz not null default now());
create table notifications_outbox (id bigserial primary key, channel text not null check (channel in ('email','sms','push')), template text not null,
  recipient text not null, payload jsonb not null default '{}', status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts int not null default 0, send_after timestamptz not null default now());
create table retention_policies (record_type text primary key, retain_years int, legal_hold boolean not null default false);

create function set_consent(p_patient uuid, p_purpose text, p_granted boolean, p_submission uuid) returns void
language plpgsql security definer set search_path=public as $$
begin
  if p_patient not in (select my_patient_ids()) and auth_role() not in ('psychologist','admin') then raise exception 'forbidden'; end if;
  insert into consents(patient_id,purpose,granted,granted_at,form_submission_id)
  values (p_patient,p_purpose,p_granted, case when p_granted then now() end, p_submission)
  on conflict (patient_id,purpose) do update set granted=excluded.granted,
    granted_at = case when excluded.granted then now() else consents.granted_at end,
    withdrawn_at = case when excluded.granted then null else now() end;
  if not p_granted then insert into tasks(title,priority,patient_id,source) values ('Consent withdrawn: '||p_purpose,'high',p_patient,'consent_withdrawn'); end if;
  perform audit_write('consent.'||case when p_granted then 'grant' else 'withdraw' end,'consents',p_patient,jsonb_build_object('purpose',p_purpose)); end $$;

alter table form_templates enable row level security; alter table form_submissions enable row level security;
alter table consents enable row level security; alter table tasks enable row level security;
alter table notifications_outbox enable row level security; alter table retention_policies enable row level security;
create policy ft_read on form_templates for select to authenticated using (true);
create policy ft_write on form_templates for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
create policy fs_staff on form_submissions for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy fs_own_read on form_submissions for select to authenticated using (patient_id in (select my_patient_ids()));
create policy fs_own_write on form_submissions for insert to authenticated with check (patient_id in (select my_patient_ids()));
create policy fs_own_update on form_submissions for update to authenticated using (patient_id in (select my_patient_ids()) and status in ('draft','returned'));
create policy co_staff on consents for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy co_own on consents for select to authenticated using (patient_id in (select my_patient_ids()));
create policy tk_staff on tasks for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
-- outbox and retention policies: service role only (no authenticated policies)
create policy rp_psy on retention_policies for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `git commit -am "feat(db): forms, consents, tasks, outbox"`

---

### Task 6: Billing and medical-aid schema

**Files:**
- Create: `supabase/migrations/0005_billing.sql`, `tests/db/billing.test.ts`

**Interfaces:**
- Produces tables `invoices`, `invoice_lines`, `credit_notes`, `payments`, `medical_aid_members`, `icd10_codes`, `claims`, `claim_events`, `claim_payments`; functions `invoice_paid_cents(uuid) returns int`, `record_payment(p_invoice uuid, p_method text, p_amount int, p_ref text, p_by uuid) returns uuid` (idempotent on `p_ref`), `record_scheme_remittance(p_claim uuid, p_amount int, p_ref text) returns void`.

- [ ] **Step 1: Failing tests**

```ts
// tests/db/billing.test.ts
import { it, expect } from "vitest";
import { withClient, asUser, mkUser } from "./helpers";

async function inv(c: any, total = 100000) {
  const psy = await mkUser(c, "psychologist"); const bk = await mkUser(c, "bookkeeper");
  const p = (await c.query("insert into patients(first_name,last_name) values ('A','B') returning id")).rows[0].id;
  const i = (await c.query("insert into invoices(patient_id,number,total_cents,patient_portion_cents,status) values ($1,'INV-1',$2,$2,'issued') returning id", [p, total])).rows[0].id;
  return { psy, bk, p, i };
}
it("partial then full payment updates status; duplicate ref is a no-op", () => withClient(async (c) => {
  const { i } = await inv(c);
  await c.query("select record_payment($1,'payfast',40000,'PF-1',null)", [i]);
  expect((await c.query("select status from invoices where id=$1", [i])).rows[0].status).toBe("part_paid");
  await c.query("select record_payment($1,'payfast',40000,'PF-1',null)", [i]); // replay
  expect((await c.query("select invoice_paid_cents($1) v", [i])).rows[0].v).toBe(40000);
  await c.query("select record_payment($1,'eft',60000,'EFT-9',null)", [i]);
  expect((await c.query("select status from invoices where id=$1", [i])).rows[0].status).toBe("paid");
}));
it("over-payment is rejected", () => withClient(async (c) => {
  const { i } = await inv(c);
  await expect(c.query("select record_payment($1,'cash',100001,null,null)", [i])).rejects.toThrow(/overpay/);
}));
it("claim submission does not change paid state; remittance does and keeps patient portion", () => withClient(async (c) => {
  const { i, p } = await inv(c);
  await c.query("update invoices set scheme_portion_cents=80000, patient_portion_cents=20000 where id=$1", [i]);
  const m = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'Discovery','123') returning id", [p])).rows[0].id;
  const cl = (await c.query("insert into claims(invoice_id,member_id,status,claimed_cents) values ($1,$2,'submitted',80000) returning id", [i, m])).rows[0].id;
  expect((await c.query("select status from invoices where id=$1", [i])).rows[0].status).toBe("issued");
  await c.query("select record_scheme_remittance($1,80000,'REM-1')", [cl]);
  const r = (await c.query("select status from invoices where id=$1", [i])).rows[0].status;
  expect(r).toBe("part_paid");
  expect((await c.query("select status from claims where id=$1", [cl])).rows[0].status).toBe("paid");
}));
it("bookkeeper cannot read ICD-10 codes on claims", () => withClient(async (c) => {
  const { bk, i, p } = await inv(c);
  const m = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'X','1') returning id", [p])).rows[0].id;
  await c.query("insert into claims(invoice_id,member_id,icd10_codes,claimed_cents) values ($1,$2,'{F41.1}',1000)", [i, m]);
  await asUser(c, bk, async () => {
    await expect(c.query("select icd10_codes from claims")).rejects.toThrow(/permission denied/);
    const ok = await c.query("select id, status, claimed_cents from claim_summary");
    expect(ok.rowCount).toBe(1);
  });
}));
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Migration**

```sql
-- supabase/migrations/0005_billing.sql
create sequence invoice_seq start 1;
create table invoices (
  id uuid primary key default gen_random_uuid(), number text not null unique default 'INV-' || lpad(nextval('invoice_seq')::text, 5, '0'),
  patient_id uuid not null references patients, appointment_id uuid references appointments,
  issue_date date not null default current_date, due_date date not null default current_date + 14,
  status text not null default 'draft' check (status in ('draft','issued','part_paid','paid','void')),
  payer_type text not null default 'self' check (payer_type in ('self','medical_aid','split')),
  subtotal_cents int not null default 0, discount_cents int not null default 0, vat_cents int not null default 0,
  total_cents int not null default 0 check (total_cents >= 0),
  scheme_portion_cents int not null default 0, patient_portion_cents int not null default 0,
  created_at timestamptz not null default now());
create table invoice_lines (id uuid primary key default gen_random_uuid(), invoice_id uuid not null references invoices on delete cascade,
  description text not null, quantity int not null default 1, unit_cents int not null, tariff_code text);
create table credit_notes (id uuid primary key default gen_random_uuid(), invoice_id uuid not null references invoices, amount_cents int not null check (amount_cents > 0), reason text not null, created_by uuid, created_at timestamptz not null default now());
create table payments (
  id uuid primary key default gen_random_uuid(), invoice_id uuid not null references invoices,
  method text not null check (method in ('payfast','eft','cash','card_machine','medical_aid')),
  gateway_ref text unique, amount_cents int not null check (amount_cents > 0),
  status text not null default 'succeeded' check (status in ('pending','succeeded','failed')),
  raw_payload jsonb, verified_at timestamptz default now(), recorded_by uuid, created_at timestamptz not null default now());

create table medical_aid_members (id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  scheme text not null, plan text, member_number text not null, dependant_code text, main_member_name text, valid_from date, valid_to date);
create table icd10_codes (code text primary key, description text not null);
insert into icd10_codes values ('F32.9','Depressive episode, unspecified'),('F41.1','Generalised anxiety disorder'),('F41.9','Anxiety disorder, unspecified'),
 ('F43.1','Post-traumatic stress disorder'),('F43.2','Adjustment disorders'),('F90.0','Attention-deficit hyperactivity disorder, inattentive'),('Z63.0','Problems in relationship with spouse or partner');
create table claims (id uuid primary key default gen_random_uuid(), invoice_id uuid not null references invoices, member_id uuid not null references medical_aid_members,
  preauth_ref text, claim_ref text, icd10_codes text[] not null default '{}', tariff_code text,
  status text not null default 'draft' check (status in ('draft','submitted','accepted','part_paid','rejected','paid')),
  submitted_at timestamptz, claimed_cents int not null default 0, approved_cents int, rejection_reason text, reconciled_at timestamptz, created_at timestamptz not null default now());
create table claim_events (id bigserial primary key, claim_id uuid not null references claims on delete cascade, event text not null, detail jsonb, actor uuid, at timestamptz not null default now());
create table claim_payments (id uuid primary key default gen_random_uuid(), claim_id uuid not null references claims, payment_id uuid not null references payments, amount_cents int not null);

create function invoice_paid_cents(p_invoice uuid) returns int language sql stable as
$$ select coalesce(sum(amount_cents),0)::int from payments where invoice_id = p_invoice and status = 'succeeded' $$;

create function payments_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare tot int; paid int; credits int; due int;
begin
  select total_cents into tot from invoices where id = new.invoice_id for update;
  select coalesce(sum(amount_cents),0) into credits from credit_notes where invoice_id = new.invoice_id;
  due := tot - credits;
  if new.status = 'succeeded' then
    select coalesce(sum(amount_cents),0) into paid from payments where invoice_id = new.invoice_id and status='succeeded' and id is distinct from new.id;
    if paid + new.amount_cents > due then raise exception 'overpay'; end if;
  end if; return new; end $$;
create trigger trg_payments_guard before insert on payments for each row execute function payments_guard();

create function invoice_recompute(p_invoice uuid) returns void language plpgsql security definer set search_path=public as $$
declare tot int; credits int; paid int;
begin
  select total_cents into tot from invoices where id = p_invoice;
  select coalesce(sum(amount_cents),0) into credits from credit_notes where invoice_id = p_invoice;
  paid := invoice_paid_cents(p_invoice);
  update invoices set status = case when status = 'void' then 'void' when paid >= tot - credits and tot - credits >= 0 and paid > 0 then 'paid'
    when paid > 0 then 'part_paid' else status end where id = p_invoice; end $$;
create function payments_after() returns trigger language plpgsql security definer set search_path=public as $$
begin perform invoice_recompute(new.invoice_id); return new; end $$;
create trigger trg_payments_after after insert or update on payments for each row execute function payments_after();

create function record_payment(p_invoice uuid, p_method text, p_amount int, p_ref text, p_by uuid) returns uuid
language plpgsql security definer set search_path=public as $$
declare pid uuid;
begin
  if auth.uid() is not null and auth_role() not in ('psychologist','admin') then raise exception 'forbidden'; end if;
  if p_ref is not null then select id into pid from payments where gateway_ref = p_ref; if pid is not null then return pid; end if; end if;
  insert into payments(invoice_id,method,gateway_ref,amount_cents,recorded_by) values (p_invoice,p_method,p_ref,p_amount,coalesce(p_by,auth.uid())) returning id into pid;
  perform audit_write('payment.record','payments',pid,jsonb_build_object('method',p_method,'amount',p_amount)); return pid; end $$;

create function record_scheme_remittance(p_claim uuid, p_amount int, p_ref text) returns void
language plpgsql security definer set search_path=public as $$
declare inv uuid; pid uuid; claimed int; got int;
begin
  if auth.uid() is not null and auth_role() not in ('psychologist','admin') then raise exception 'forbidden'; end if;
  select invoice_id, claimed_cents into inv, claimed from claims where id = p_claim;
  pid := record_payment(inv,'medical_aid',p_amount,p_ref,null);
  insert into claim_payments(claim_id,payment_id,amount_cents) values (p_claim,pid,p_amount);
  select sum(amount_cents) into got from claim_payments where claim_id = p_claim;
  update claims set status = case when got >= claimed then 'paid' else 'part_paid' end, reconciled_at = now() where id = p_claim;
  insert into claim_events(claim_id,event,detail,actor) values (p_claim,'remittance',jsonb_build_object('amount',p_amount,'ref',p_ref),auth.uid()); end $$;

create function claims_events() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into claim_events(claim_id,event,actor) values (new.id,'status:'||new.status,auth.uid()); end if;
  if new.status = 'rejected' and (tg_op = 'INSERT' or old.status <> 'rejected') then
    insert into tasks(title,priority,source) values ('Claim rejected: follow up and resubmit','high','claim_rejected'); end if;
  return new; end $$;
create trigger trg_claims_events after insert or update on claims for each row execute function claims_events();

-- RLS
alter table invoices enable row level security; alter table invoice_lines enable row level security; alter table credit_notes enable row level security;
alter table payments enable row level security; alter table medical_aid_members enable row level security; alter table icd10_codes enable row level security;
alter table claims enable row level security; alter table claim_events enable row level security; alter table claim_payments enable row level security;
create policy inv_fin on invoices for all to authenticated using (auth_role() in ('psychologist','admin','bookkeeper')) with check (auth_role() in ('psychologist','admin'));
create policy inv_own on invoices for select to authenticated using (patient_id in (select my_patient_ids()));
create policy il_fin on invoice_lines for all to authenticated using (auth_role() in ('psychologist','admin','bookkeeper')) with check (auth_role() in ('psychologist','admin'));
create policy il_own on invoice_lines for select to authenticated using (invoice_id in (select id from invoices where patient_id in (select my_patient_ids())));
create policy cr_fin on credit_notes for select to authenticated using (auth_role() in ('psychologist','admin','bookkeeper'));
create policy cr_write on credit_notes for insert to authenticated with check (auth_role() = 'psychologist');
create policy pay_fin on payments for select to authenticated using (auth_role() in ('psychologist','admin','bookkeeper'));
create policy pay_own on payments for select to authenticated using (invoice_id in (select id from invoices where patient_id in (select my_patient_ids())));
create policy mam_staff on medical_aid_members for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy mam_own on medical_aid_members for select to authenticated using (patient_id in (select my_patient_ids()));
create policy icd_read on icd10_codes for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy cl_staff on claims for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy ce_staff on claim_events for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy cp_staff on claim_payments for select to authenticated using (auth_role() in ('psychologist','admin','bookkeeper'));
-- bookkeeper sees claim amounts and statuses only, via a view that omits codes, member and patient identity
create view claim_summary with (security_invoker = false) as
  select c.id, c.invoice_id, c.status, c.claimed_cents, c.approved_cents, c.submitted_at from claims c
  where auth_role() in ('psychologist','admin','bookkeeper');
grant select on claim_summary to authenticated;
```

- [ ] **Step 4: Run, expect PASS.** `npx supabase db reset; npm run test:db`
- [ ] **Step 5: Commit** `git commit -am "feat(db): billing, payments integrity, medical-aid claims"`

---

### Task 7: Cross-table isolation test suite

**Files:**
- Create: `tests/db/isolation.test.ts`

**Interfaces:** Consumes all earlier tables.

- [ ] **Step 1: Write the test** — for each patient-owned table, create two patients with separate users, seed one row for each, and assert patient A reads exactly one row and cannot update or delete B's rows.

```ts
import { it, expect } from "vitest";
import { withClient, asUser, mkUser } from "./helpers";
const TABLES = ["patients","appointments","form_submissions","consents","invoices","payments","medical_aid_members","guardianships"];
it.each(TABLES)("patient A cannot read patient B's %s", (table) => withClient(async (c) => {
  const ua = await mkUser(c, "patient"), ub = await mkUser(c, "patient");
  const pa = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [ua])).rows[0].id;
  const pb = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','B') returning id", [ub])).rows[0].id;
  const st = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('t',50,1000) returning id")).rows[0].id;
  const ft = (await c.query("insert into form_templates(key,version,schema) values ('k',1,'{}') returning id")).rows[0].id;
  for (const [pid, hour] of [[pa, "08"], [pb, "10"]] as const) {
    await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,$3,$4)", [pid, st, `2031-01-07T${hour}:00:00Z`, `2031-01-07T${hour}:50:00Z`]);
    await c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1)", [pid, ft]);
    await c.query("insert into consents(patient_id,purpose,granted) values ($1,'treatment',true)", [pid]);
    const iv = (await c.query("insert into invoices(patient_id,total_cents) values ($1,1000) returning id", [pid])).rows[0].id;
    await c.query("insert into payments(invoice_id,method,amount_cents) values ($1,'eft',100)", [iv]);
    await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'S','1')", [pid]);
    await c.query("insert into guardianships(guardian_user_id,patient_id) values ($1,$2)", [pid === pa ? ua : ub, pid]);
  }
  const rows = await asUser(c, ua, async () => (await c.query(`select * from ${table}`)).rowCount);
  expect(rows).toBe(1);
}));
it("a guardian sees only linked patients", () => withClient(async (c) => {
  const g = await mkUser(c, "guardian");
  const kid = (await c.query("insert into patients(first_name,last_name,is_minor) values ('K','K',true) returning id")).rows[0].id;
  await c.query("insert into patients(first_name,last_name) values ('Other','O')");
  await c.query("insert into guardianships(guardian_user_id,patient_id) values ($1,$2)", [g, kid]);
  const n = await asUser(c, g, async () => (await c.query("select 1 from patients")).rowCount);
  expect(n).toBe(1);
}));
```

- [ ] **Step 2: Run** `npm run test:db -- isolation` → expect PASS (fix policies from Tasks 2 to 6 if any fail; do not weaken the test).
- [ ] **Step 3: Commit** `git commit -am "test(db): patient isolation across all tables"`

---

### Task 8: Auth, MFA and server authorisation

**Files:**
- Create: `lib/supabase/{server,client,service}.ts`, `lib/auth/session.ts`, `lib/audit.ts`, `middleware.ts`, `app/(auth)/login/page.tsx`, `app/(auth)/mfa/page.tsx`, `app/(auth)/recover/page.tsx`, `app/(auth)/actions.ts`
- Test: `tests/unit/roles.test.ts`

**Interfaces:**
- Produces: `type Role = "psychologist"|"admin"|"bookkeeper"|"patient"|"guardian"|"associate"`; `homeFor(role: Role): string` (staff → `/app`, patient and guardian → `/portal`); `requireRole(allowed: Role[]): Promise<{ userId: string; role: Role }>` (redirects to `/login` when anonymous, to `/mfa` when a staff user is not aal2, calls `notFound()` when the role is not allowed); `audit(action: string, entity?: string, entityId?: string, detail?: object): Promise<void>`.

- [ ] **Step 1: Failing test**

```ts
// tests/unit/roles.test.ts
import { it, expect } from "vitest";
import { homeFor, isStaffRole, needsMfa } from "@/lib/auth/roles";
it("routes roles to the right area", () => {
  expect(homeFor("psychologist")).toBe("/app"); expect(homeFor("admin")).toBe("/app");
  expect(homeFor("patient")).toBe("/portal"); expect(homeFor("guardian")).toBe("/portal");
});
it("staff need MFA, patients do not", () => {
  expect(needsMfa("bookkeeper")).toBe(true); expect(needsMfa("patient")).toBe(false); expect(isStaffRole("associate")).toBe(true);
});
```

- [ ] **Step 2: Run** `npm run test:unit` → FAIL.

- [ ] **Step 3: Implement pure role helpers**

```ts
// lib/auth/roles.ts
export type Role = "psychologist" | "admin" | "bookkeeper" | "patient" | "guardian" | "associate";
const STAFF: Role[] = ["psychologist", "admin", "bookkeeper", "associate"];
export const isStaffRole = (r: Role) => STAFF.includes(r);
export const needsMfa = isStaffRole;
export const homeFor = (r: Role) => (isStaffRole(r) ? "/app" : "/portal");
```

- [ ] **Step 4: Implement Supabase clients and `requireRole`**

```ts
// lib/supabase/server.ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => store.getAll(), setAll: (list) => { try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch {} } },
  });
}
// lib/supabase/service.ts  (server only; never import from client components)
import "server-only";
import { createClient } from "@supabase/supabase-js";
export const supabaseService = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
```
```ts
// lib/auth/session.ts
import { redirect, notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { Role, needsMfa } from "./roles";
export async function requireRole(allowed: Role[]) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await sb.from("profiles").select("role").eq("user_id", user.id).single();
  if (!profile) redirect("/login");
  const role = profile.role as Role;
  if (needsMfa(role)) {
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== "aal2") redirect("/mfa");
  }
  if (!allowed.includes(role)) notFound();
  return { userId: user.id, role };
}
// lib/audit.ts
import { supabaseServer } from "@/lib/supabase/server";
export async function audit(action: string, entity?: string, entityId?: string, detail?: object) {
  const sb = await supabaseServer();
  await sb.rpc("audit_write", { p_action: action, p_entity: entity ?? null, p_entity_id: entityId ?? null, p_detail: detail ?? null });
}
```

- [ ] **Step 5: Pages and actions.** `login` (email + password via `signInWithPassword`, logs `auth.login` through `audit`), `mfa` (enrol with `sb.auth.mfa.enroll({factorType:"totp"})` showing the QR and secret, then `challengeAndVerify`; if already enrolled, only verify), `recover` (`resetPasswordForEmail`, always show the same confirmation message to avoid account enumeration). `middleware.ts` refreshes the session cookie using `@supabase/ssr` and redirects anonymous users from `/app` and `/portal` to `/login`. Set Supabase Auth config in `supabase/config.toml`: `[auth.mfa.totp] enroll_enabled = true, verify_enabled = true`; `jwt_expiry = 3600`; `enable_signup = true` (patients only; the profile trigger below assigns `patient`).

Add to `supabase/migrations/0006_signup.sql`:
```sql
create function handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into profiles(user_id, role, display_name) values (new.id, 'patient', coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)));
  return new; end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();
```
Staff accounts are created by the owner in the Supabase dashboard and promoted with SQL `update profiles set role='psychologist' …` (documented in README, Task 17).

- [ ] **Step 6: Run** `npm run test:unit; npm run typecheck` → PASS.
- [ ] **Step 7: Commit** `git commit -am "feat(auth): sign-in, TOTP MFA, requireRole, audit helper"`

---

### Task 9: Slot engine and cancellation policy (pure)

**Files:**
- Create: `lib/booking/slots.ts`, `lib/booking/policy.ts`
- Test: `tests/unit/slots.test.ts`, `tests/unit/policy.test.ts`

**Interfaces:**
- Produces:
```ts
type Rule = { weekday: number; start: string; end: string }          // "HH:MM" local
type Range = { start: string; end: string }                          // ISO instants
generateSlots(o: { date: string; rules: Rule[]; busy: Range[]; durationMin: number; bufferMin: number; now: Date }): string[]  // ISO start instants, SAST day
cancellationOutcome(o: { startsAt: Date; now: Date; windowHours: number; lateFeeCents: number }): { allowed: true; late: boolean; feeCents: number }
```

- [ ] **Step 1: Failing tests**

```ts
// tests/unit/slots.test.ts
import { it, expect } from "vitest";
import { generateSlots } from "@/lib/booking/slots";
const rules = [{ weekday: 1, start: "08:00", end: "12:00" }]; // Monday
const base = { rules, durationMin: 50, bufferMin: 10, now: new Date("2030-01-01T00:00:00Z") };
it("builds slots in SAST on the right day", () => {
  const s = generateSlots({ ...base, date: "2030-01-07", busy: [] }); // 2030-01-07 is a Monday
  expect(s[0]).toBe("2030-01-07T06:00:00.000Z"); // 08:00 SAST
  expect(s).toHaveLength(4);
});
it("removes busy overlaps including buffer", () => {
  const s = generateSlots({ ...base, date: "2030-01-07", busy: [{ start: "2030-01-07T07:00:00Z", end: "2030-01-07T07:50:00Z" }] });
  expect(s).not.toContain("2030-01-07T07:00:00.000Z");
  expect(s).not.toContain("2030-01-07T06:00:00.000Z"); // would collide with the buffer before the busy range
});
it("hides past slots and non-working days", () => {
  expect(generateSlots({ ...base, date: "2030-01-08", busy: [] })).toEqual([]);
  expect(generateSlots({ ...base, now: new Date("2030-01-07T07:30:00Z"), date: "2030-01-07", busy: [] }).every(x => x > "2030-01-07T07:30:00Z")).toBe(true);
});
```
```ts
// tests/unit/policy.test.ts
import { it, expect } from "vitest";
import { cancellationOutcome } from "@/lib/booking/policy";
it("late cancellations incur the fee", () => {
  const o = cancellationOutcome({ startsAt: new Date("2030-01-07T08:00:00Z"), now: new Date("2030-01-07T00:00:00Z"), windowHours: 24, lateFeeCents: 50000 });
  expect(o).toEqual({ allowed: true, late: true, feeCents: 50000 });
});
it("early cancellations are free", () => {
  const o = cancellationOutcome({ startsAt: new Date("2030-01-09T08:00:00Z"), now: new Date("2030-01-07T00:00:00Z"), windowHours: 24, lateFeeCents: 50000 });
  expect(o.feeCents).toBe(0);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// lib/booking/slots.ts
const SAST_MS = 2 * 3600_000; // Africa/Johannesburg has no DST
export type Rule = { weekday: number; start: string; end: string };
export type Range = { start: string; end: string };
const mins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

export function generateSlots(o: { date: string; rules: Rule[]; busy: Range[]; durationMin: number; bufferMin: number; now: Date }): string[] {
  const dayStart = Date.parse(`${o.date}T00:00:00Z`) - SAST_MS;       // local midnight as an instant
  const weekday = new Date(dayStart + SAST_MS).getUTCDay();
  const step = (o.durationMin + o.bufferMin) * 60_000, dur = o.durationMin * 60_000, buf = o.bufferMin * 60_000;
  const busy = o.busy.map(b => [Date.parse(b.start) - buf, Date.parse(b.end) + buf] as const);
  const out: string[] = [];
  for (const r of o.rules.filter(r => r.weekday === weekday)) {
    const end = dayStart + mins(r.end) * 60_000;
    for (let t = dayStart + mins(r.start) * 60_000; t + dur <= end; t += step) {
      if (t <= o.now.getTime()) continue;
      if (busy.some(([a, b]) => t < b && t + dur > a)) continue;
      out.push(new Date(t).toISOString());
    }
  }
  return out.sort();
}
// lib/booking/policy.ts
export function cancellationOutcome(o: { startsAt: Date; now: Date; windowHours: number; lateFeeCents: number }) {
  const late = o.startsAt.getTime() - o.now.getTime() < o.windowHours * 3600_000;
  return { allowed: true as const, late, feeCents: late ? o.lateFeeCents : 0 };
}
```

- [ ] **Step 4: Run, expect PASS.** (The first busy-overlap test passes because the buffer widens the busy range: the 06:00 slot ends 06:50, within 10 minutes of the 07:00 busy start.)
- [ ] **Step 5: Commit** `git commit -am "feat(booking): slot engine and cancellation policy"`

---

### Task 10: Booking journey (public and portal) and staff calendar

**Files:**
- Create: `app/(public)/book/page.tsx`, `app/(public)/book/actions.ts`, `app/portal/appointments/page.tsx`, `app/portal/appointments/actions.ts`, `app/app/calendar/page.tsx`, `app/app/calendar/actions.ts`, `lib/booking/availability.ts`
- Test: `tests/e2e/booking.spec.ts`

**Interfaces:**
- Consumes: `generateSlots`, `cancellationOutcome`, `book_appointment`, `busy_ranges`, `requireRole`, `audit`.
- Produces: `getSlots(typeId: string, date: string): Promise<string[]>` in `lib/booking/availability.ts` (reads rules via anon client, `busy_ranges` via RPC for the SAST day ±1 day); server actions `bookAppointment(input: {typeId; startIso; acceptedTerms: true})`, `cancelAppointment(id: string)`, `rescheduleAppointment(id: string, newStartIso: string)`.

- [ ] **Step 1: Public flow.** `/book` is a stepper: session type → date and slot (from `getSlots`; shows duration, format, fee, hours) → sign in or register (email, password, name only) → accept booking and cancellation terms (checkbox, required) → confirmation. Public page shows times only, never names. After auth, `bookAppointment` validates with Zod, derives `patientId` from `my_patient_ids()` (creating the `patients` row from the profile on first booking), calls `book_appointment(..., status)` where status is `confirmed` for `approval_mode=auto` else `tentative`. On error `slot_taken`, re-fetch slots and show "That time was just taken. Choose another." Queue a confirmation row into `notifications_outbox` (template `booking_confirmed`, payload with date and time only). Add the practice `crisis_text` disclaimer to the confirmation.

Approval-mode requests use `tentative`, because the exclusion constraint covers `tentative` and `confirmed` and so holds the slot. The UI shows `tentative` as "Requested". The psychologist's confirm action moves it to `confirmed`; decline moves it to `cancelled`. The `requested` status value is unused in Phase 1.

- [ ] **Step 2: Cancel and reschedule.** `cancelAppointment` re-reads the appointment through the user's own client (RLS blocks others), runs `cancellationOutcome` with practice settings, sets `status='cancelled'`, `cancelled_by`, records an audit entry, queues notifications, and when `late && feeCents>0` creates a draft invoice with a "Late cancellation fee" line. `rescheduleAppointment` books the new slot first (so a conflict aborts safely), then cancels the old one with no fee when the change is outside the window.

- [ ] **Step 3: Staff calendar.** `/app/calendar` (psychologist and admin) with day, week and agenda views (CSS grid; agenda is the mobile default), filters by status, search by patient name, status shown as text plus icon, buttons to confirm, decline, cancel, reschedule, and mark `attended` or `no_show`. Blocked time and working hours management live in Settings (Task 16).

- [ ] **Step 4: E2E test**

```ts
// tests/e2e/booking.spec.ts
import { test, expect } from "@playwright/test";
test("two browsers cannot take the same slot", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage(); const b = await (await browser.newContext()).newPage();
  for (const p of [a, b]) { await p.goto("/book"); await p.getByRole("button", { name: /Therapy/ }).click(); await p.getByRole("button", { name: /^\d{2}:\d{2}/ }).first().click(); }
  // both are signed in as seeded patients via storage state in playwright config (see Task 17)
  await Promise.all([a.getByRole("button", { name: "Confirm booking" }).click(), b.getByRole("button", { name: "Confirm booking" }).click()]);
  const texts = await Promise.all([a.locator("main").innerText(), b.locator("main").innerText()]);
  expect(texts.filter(t => /Booking (confirmed|requested)/.test(t))).toHaveLength(1);
  expect(texts.filter(t => /just taken/.test(t))).toHaveLength(1);
});
```

- [ ] **Step 5: Run** `npm run typecheck; npm run test:unit` and, with the local stack, `npx playwright test booking`. Expected PASS.
- [ ] **Step 6: Commit** `git commit -am "feat(booking): public/portal booking, reschedule, cancel, staff calendar"`

---

### Task 11: Patients, intake forms and consent UI

**Files:**
- Create: `app/app/patients/page.tsx`, `app/app/patients/[id]/page.tsx`, `app/app/patients/actions.ts`, `app/portal/documents/page.tsx`, `app/portal/documents/[submissionId]/page.tsx`, `app/portal/documents/actions.ts`, `lib/forms/render.tsx`, `supabase/seed_forms.sql` (merged into `supabase/seed.sql`)
- Test: `tests/unit/forms.test.ts`

**Interfaces:**
- Produces: `validateAnswers(schema: FormSchema, answers: Record<string, unknown>): { ok: boolean; errors: Record<string,string> }` in `lib/forms/validate.ts`; `FormSchema = { fields: { key: string; label: string; type: "text"|"textarea"|"date"|"select"|"checkbox"; required?: boolean; options?: string[]; consentPurpose?: string }[] }`.

- [ ] **Step 1: Failing test**

```ts
import { it, expect } from "vitest";
import { validateAnswers } from "@/lib/forms/validate";
const schema = { fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "agree", label: "I consent", type: "checkbox", required: true, consentPurpose: "treatment" }] } as const;
it("flags missing required fields", () => {
  const r = validateAnswers(schema as any, { name: "" });
  expect(r.ok).toBe(false); expect(r.errors.name).toBeTruthy(); expect(r.errors.agree).toBeTruthy();
});
it("passes complete answers", () => expect(validateAnswers(schema as any, { name: "A", agree: true }).ok).toBe(true));
```

- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement**

```ts
// lib/forms/validate.ts
export type FormField = { key: string; label: string; type: "text"|"textarea"|"date"|"select"|"checkbox"; required?: boolean; options?: string[]; consentPurpose?: string };
export type FormSchema = { fields: FormField[] };
export function validateAnswers(schema: FormSchema, answers: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  for (const f of schema.fields) {
    const v = answers[f.key];
    if (f.required && (v === undefined || v === null || v === "" || v === false)) errors[f.key] = `${f.label} is required`;
    if (f.type === "select" && v && f.options && !f.options.includes(String(v))) errors[f.key] = `${f.label} has an invalid choice`;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}
```

- [ ] **Step 4: Seed templates** in `supabase/seed.sql`: `registration`, `medical_history`, `informed_consent` (checkbox with `consentPurpose: "treatment"`), `privacy_notice` (`privacy_notice`), `telehealth_consent` (`telehealth`), `financial_terms` (`financial_terms`), `guardian_info`, `share_with_referrer` (`share_referrer`), each as version 1 with real fields and clear plain-language wording marked "Draft wording, to be reviewed by the practice and legal advisor".

- [ ] **Step 5: Portal documents.** List assigned and outstanding forms, open one, autosave draft answers (debounced 1.5 s via server action `saveDraft(submissionId, answers)`, "Saved" indicator), and `submitForm` that runs `validateAnswers` server-side, sets `status='submitted'`, `submitted_at=now()`, and calls `set_consent` for every field with `consentPurpose` (each purpose separately). Withdrawal control on the privacy page calls `set_consent(..., false)`.

- [ ] **Step 6: Staff patients.** List with search, patient record page with tabs: Profile, Administrative, Consent and forms (request form, return for correction), Notes (Task 12), Billing (Task 13), Medical aid (Task 14), Audit (psychologist only; shows `audit_log` filtered by `entity_id`). Creating a patient checks for a duplicate by normalised email, phone, or name plus date of birth, and warns before creating. Every patient-record page load calls `audit("patient.view", "patients", id)`.

- [ ] **Step 7: Run** `npm run test:unit; npm run typecheck`. **Step 8: Commit** `git commit -am "feat(patients): records, intake forms, per-purpose consent"`

---

### Task 12: Clinical notes UI

**Files:**
- Create: `app/app/patients/[id]/notes/new/page.tsx`, `app/app/notes/[noteId]/page.tsx`, `app/app/notes/actions.ts`, `lib/notes/risk.ts`
- Test: `tests/unit/risk.test.ts`

**Interfaces:**
- Produces: `riskTask(risk: { level?: "none"|"low"|"moderate"|"high"; notes?: string }): { title: string; priority: "high" } | null` which returns a task only for `moderate` or `high`.
- Server actions: `createNote(patientId, appointmentId?, templateId)`, `saveDraft(noteId, content)`, `signNote(noteId)`, `addAddendum(noteId, text)`, all behind `requireRole(["psychologist"])`.

- [ ] **Step 1: Failing test**

```ts
import { it, expect } from "vitest";
import { riskTask } from "@/lib/notes/risk";
it("creates a professional-assessment task for moderate and high risk only", () => {
  expect(riskTask({ level: "none" })).toBeNull();
  expect(riskTask({ level: "high" })?.title).toMatch(/professional assessment/i);
  expect(riskTask({ level: "moderate" })?.priority).toBe("high");
});
```
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement**

```ts
// lib/notes/risk.ts
export function riskTask(risk: { level?: string; notes?: string }) {
  if (risk.level !== "moderate" && risk.level !== "high") return null;
  return { title: "Risk flagged: professional assessment and follow-up required", priority: "high" as const };
}
```
- [ ] **Step 4: UI.** Template-driven form from `note_templates.schema.fields`; draft autosave every 3 s with "Saving / Saved at hh:mm"; risk section (level select plus notes) that, on save, inserts the `riskTask` result into `tasks` (never an automated diagnosis); Sign button with an inline confirmation panel (no `confirm()`), then read-only view with author and signed time, version history list (from `note_versions`), and an Addendum form. Link the note to its appointment; the dashboard "Notes to complete" count is `attended` appointments lacking a signed note.
- [ ] **Step 5: Run** `npm run test:unit; npm run typecheck`. **Step 6: Commit** `git commit -am "feat(notes): templates, autosave, sign, addenda, risk task"`

---

### Task 13: Invoicing, manual payments and PayFast

**Files:**
- Create: `lib/money.ts`, `lib/billing/invoice.ts`, `lib/payments/payfast.ts`, `app/api/payfast/itn/route.ts`, `app/app/billing/page.tsx`, `app/app/billing/[invoiceId]/page.tsx`, `app/app/billing/actions.ts`, `app/portal/payments/page.tsx`, `app/portal/payments/actions.ts`
- Test: `tests/unit/invoice.test.ts`, `tests/unit/payfast.test.ts`, `tests/db/itn.test.ts`

**Interfaces:**
- Produces:
```ts
formatZar(cents: number): string                                  // "R 1 234,50"
computeInvoice(o: { lines: {quantity:number; unitCents:number}[]; discountCents: number; vatRegistered: boolean; vatRate: number }): { subtotal: number; discount: number; vat: number; total: number }
payfastSignature(params: Record<string,string>, passphrase?: string): string
buildCheckout(o: { invoiceId: string; number: string; amountCents: number; name: string; email: string }): { action: string; fields: Record<string,string> }
verifyItn(o: { rawBody: string; sourceIp: string; expectedCents: (invoiceId: string) => Promise<number>; validate: (body: string) => Promise<boolean> }): Promise<{ ok: boolean; invoiceId?: string; ref?: string; amountCents?: number; status?: string; reason?: string }>
```

- [ ] **Step 1: Failing unit tests**

```ts
// tests/unit/invoice.test.ts
import { it, expect } from "vitest";
import { computeInvoice } from "@/lib/billing/invoice";
import { formatZar } from "@/lib/money";
it("totals with discount and VAT (VAT-exclusive prices)", () => {
  expect(computeInvoice({ lines: [{ quantity: 2, unitCents: 50000 }], discountCents: 10000, vatRegistered: true, vatRate: 15 }))
    .toEqual({ subtotal: 100000, discount: 10000, vat: 13500, total: 103500 });
});
it("no VAT when not registered", () => expect(computeInvoice({ lines: [{ quantity: 1, unitCents: 95000 }], discountCents: 0, vatRegistered: false, vatRate: 15 }).total).toBe(95000));
it("formats rand", () => expect(formatZar(123450)).toBe("R 1 234,50"));
```
```ts
// tests/unit/payfast.test.ts
import { it, expect } from "vitest";
import { payfastSignature, verifyItn } from "@/lib/payments/payfast";
import { createHash } from "crypto";
it("signs params in order with url-encoded values and passphrase", () => {
  const exp = createHash("md5").update("m_payment_id=INV-1&amount=950.00&passphrase=pass+word").digest("hex");
  expect(payfastSignature({ m_payment_id: "INV-1", amount: "950.00" }, "pass word")).toBe(exp);
});
const mk = (over: Record<string,string> = {}) => {
  const p: Record<string,string> = { m_payment_id: "inv-uuid", pf_payment_id: "777", payment_status: "COMPLETE", amount_gross: "950.00", ...over };
  const body = new URLSearchParams({ ...p, signature: payfastSignature(p, "pp") }).toString();
  return body;
};
const base = { sourceIp: "197.97.145.150", expectedCents: async () => 95000, validate: async () => true };
it("accepts a genuine ITN", async () => {
  process.env.PAYFAST_PASSPHRASE = "pp";
  expect((await verifyItn({ rawBody: mk(), ...base })).ok).toBe(true);
});
it("rejects bad signature, wrong amount, wrong IP, failed validation", async () => {
  process.env.PAYFAST_PASSPHRASE = "pp";
  expect((await verifyItn({ rawBody: mk().replace("777", "778"), ...base })).ok).toBe(false);
  expect((await verifyItn({ rawBody: mk({ amount_gross: "10.00" }), ...base })).ok).toBe(false);
  expect((await verifyItn({ rawBody: mk(), ...base, sourceIp: "1.2.3.4" })).ok).toBe(false);
  expect((await verifyItn({ rawBody: mk(), ...base, validate: async () => false })).ok).toBe(false);
});
```
- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
// lib/money.ts
export function formatZar(cents: number) {
  const neg = cents < 0; const abs = Math.abs(cents);
  const rand = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}R ${rand},${String(abs % 100).padStart(2, "0")}`;
}
// lib/billing/invoice.ts
export function computeInvoice(o: { lines: { quantity: number; unitCents: number }[]; discountCents: number; vatRegistered: boolean; vatRate: number }) {
  const subtotal = o.lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
  const taxable = Math.max(0, subtotal - o.discountCents);
  const vat = o.vatRegistered ? Math.round((taxable * o.vatRate) / 100) : 0;
  return { subtotal, discount: o.discountCents, vat, total: taxable + vat };
}
```
```ts
// lib/payments/payfast.ts
import { createHash } from "crypto";
const enc = (v: string) => encodeURIComponent(v.trim()).replace(/%20/g, "+");
export function payfastSignature(params: Record<string, string>, passphrase?: string) {
  let s = Object.entries(params).filter(([k, v]) => k !== "signature" && v !== "").map(([k, v]) => `${k}=${enc(v)}`).join("&");
  if (passphrase) s += `&passphrase=${enc(passphrase)}`;
  return createHash("md5").update(s).digest("hex");
}
const host = () => (process.env.PAYFAST_SANDBOX === "true" ? "sandbox.payfast.co.za" : "www.payfast.co.za");
export function buildCheckout(o: { invoiceId: string; number: string; amountCents: number; name: string; email: string }) {
  const fields: Record<string, string> = {
    merchant_id: process.env.PAYFAST_MERCHANT_ID!, merchant_key: process.env.PAYFAST_MERCHANT_KEY!,
    return_url: `${process.env.APP_URL}/portal/payments?paid=${o.invoiceId}`, cancel_url: `${process.env.APP_URL}/portal/payments`,
    notify_url: `${process.env.APP_URL}/api/payfast/itn`, name_first: o.name, email_address: o.email,
    m_payment_id: o.invoiceId, amount: (o.amountCents / 100).toFixed(2), item_name: `Invoice ${o.number}`,
  };
  return { action: `https://${host()}/eng/process`, fields: { ...fields, signature: payfastSignature(fields, process.env.PAYFAST_PASSPHRASE) } };
}
// PayFast source ranges. Verify against PayFast's current documentation before go-live.
const VALID_IPS = [/^197\.97\.145\.1(4[4-9]|5\d)$/, /^41\.74\.179\.(19[2-9]|2\d\d)$/, /^102\.216\.36\.([0-9]|1[0-5])$/, /^102\.216\.36\.(12[89]|13\d|14[0-3])$/, /^144\.126\.193\.139$/];
export const payfastValidate = async (body: string) =>
  (await (await fetch(`https://${host()}/eng/query/validate`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body })).text()).trim() === "VALID";
export async function verifyItn(o: { rawBody: string; sourceIp: string; expectedCents: (invoiceId: string) => Promise<number>; validate: (body: string) => Promise<boolean> }) {
  const p = Object.fromEntries(new URLSearchParams(o.rawBody));
  if (process.env.PAYFAST_SANDBOX !== "true" && !VALID_IPS.some(r => r.test(o.sourceIp))) return { ok: false, reason: "bad_ip" };
  if (process.env.PAYFAST_SANDBOX === "true" && !VALID_IPS.some(r => r.test(o.sourceIp)) && o.sourceIp !== "197.97.145.150") return { ok: false, reason: "bad_ip" };
  if (payfastSignature(p, process.env.PAYFAST_PASSPHRASE) !== p.signature) return { ok: false, reason: "bad_signature" };
  const amountCents = Math.round(parseFloat(p.amount_gross) * 100);
  if (amountCents !== (await o.expectedCents(p.m_payment_id))) return { ok: false, reason: "amount_mismatch" };
  if (!(await o.validate(o.rawBody))) return { ok: false, reason: "server_validation_failed" };
  return { ok: true, invoiceId: p.m_payment_id, ref: p.pf_payment_id, amountCents, status: p.payment_status };
}
```
(The sandbox IP branch exists only so tests and sandbox testing work; production always requires a listed PayFast range.)

- [ ] **Step 4: ITN route.** `expectedCents` is the invoice's outstanding balance, and `verifyItn` requires the notified amount to equal it. The online checkout therefore always bills the full outstanding balance in Phase 1. Partial payments come from manual and medical-aid recording.

```ts
// app/api/payfast/itn/route.ts
import { NextRequest } from "next/server";
import { verifyItn, payfastValidate } from "@/lib/payments/payfast";
import { supabaseService } from "@/lib/supabase/service";
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const sb = supabaseService();
  const r = await verifyItn({
    rawBody, sourceIp: ip, validate: payfastValidate,
    expectedCents: async (id) => {
      const { data } = await sb.from("invoices").select("total_cents").eq("id", id).single();
      const { data: paid } = await sb.rpc("invoice_paid_cents", { p_invoice: id });
      return (data?.total_cents ?? 0) - (paid ?? 0);
    },
  });
  if (!r.ok) { await sb.from("audit_log").insert({ action: "payfast.itn.rejected", entity: "payments", detail: { reason: r.reason } }); return new Response("rejected", { status: 400 }); }
  if (r.status === "COMPLETE") await sb.rpc("record_payment", { p_invoice: r.invoiceId, p_method: "payfast", p_amount: r.amountCents, p_ref: `PF-${r.ref}`, p_by: null });
  return new Response("ok");
}
```
The replay of an already-paid ITN: `expectedCents` returns 0 after payment, so the amount comparison fails and the request is rejected. The DB-level idempotency on `gateway_ref` also protects against a race. Add `tests/db/itn.test.ts` asserting two concurrent `record_payment` calls with the same ref produce one payment row.

- [ ] **Step 5: Billing UI.** `/app/billing` (list, filter by status and payer type, overdue badge with text) and invoice detail: lines, totals via `computeInvoice` and practice VAT settings, payer type (`self|medical_aid|split`) with scheme/patient portions that must sum to total (server-validated), issue button (moves `draft` to `issued`), record manual payment form (method `eft|cash|card_machine`, amount, reference, date → `record_payment`), credit note form (psychologist only, reason required), payment history, receipt view. "Generate invoice" from an `attended` appointment pre-fills the line and `tariff_code`. Patient portal Payments: outstanding invoices with a "Pay now" form posting to PayFast's `action` using `buildCheckout`, history and receipts; the success `return_url` page only displays stored status.
- [ ] **Step 6: Run** `npm run test:unit; npm run test:db; npm run typecheck`. **Step 7: Commit** `git commit -am "feat(billing): invoices, manual payments, PayFast checkout and verified ITN"`

---

### Task 14: Medical-aid UI

**Files:**
- Create: `app/app/patients/[id]/medical-aid/page.tsx`, `app/app/claims/page.tsx`, `app/app/claims/[claimId]/page.tsx`, `app/app/claims/actions.ts`
- Test: `tests/e2e/claims.spec.ts`

**Interfaces:**
- Consumes: `claims`, `claim_events`, `record_scheme_remittance`, `icd10_codes`, `requireRole(["psychologist","admin"])` (bookkeeper reaches only `/app/reports` via `claim_summary`).
- Server actions: `saveMember(patientId, form)`, `openClaim(invoiceId, memberId, {icd10: string[], tariff?: string, preauth?: string})`, `markSubmitted(claimId, claimRef)`, `markAccepted(claimId, approvedCents)`, `markRejected(claimId, reason)`, `resubmit(claimId)` (sets status `submitted` again; history stays in `claim_events`), `recordRemittance(claimId, amountCents, ref)`.

- [ ] **Step 1: Member page** — scheme, plan, member number, dependant code, main member; validated with Zod.
- [ ] **Step 2: Claims list and detail** — board by status with text labels, patient and scheme portions shown separately ("Scheme owes R x" / "Patient owes R y"), ICD-10 picker backed by `icd10_codes` (searchable, multiple), timeline from `claim_events`, rejection reason and resubmission, remittance form. A visible note: "Submission is tracked manually in this version; submit through your scheme or clearing house and record the outcome here."
- [ ] **Step 3: E2E** — create invoice with medical-aid payer type, open claim, mark submitted (invoice still `issued`), record remittance (invoice `part_paid`, patient portion still outstanding and payable), reject path creates a task.
- [ ] **Step 4: Run** `npx playwright test claims; npm run typecheck`. **Step 5: Commit** `git commit -am "feat(claims): medical-aid members and manual claim tracking"`

---

### Task 15: Reminders and notification outbox

**Files:**
- Create: `lib/notify/provider.ts`, `lib/notify/templates.ts`, `app/api/cron/reminders/route.ts`, `supabase/migrations/0007_cron.sql`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Produces: `renderTemplate(name: "booking_confirmed"|"reminder_24h"|"payment_receipt"|"invoice_issued", data: {date?: string; time?: string; link: string; invoiceNumber?: string}): { subject: string; text: string }`; `interface Provider { send(channel: "email"|"sms"|"push", to: string, msg: {subject: string; text: string}): Promise<void> }`; `getProvider()` returns `ConsoleProvider` (logs only) unless `EMAIL_API_KEY` is set, in which case an `HttpEmailProvider` is used (to be wired when the practice picks a provider; SMS and push remain console).

- [ ] **Step 1: Failing test** asserting no rendered template contains clinical words or patient last names:

```ts
import { it, expect } from "vitest";
import { renderTemplate } from "@/lib/notify/templates";
it("reminders contain date, time and link only", () => {
  const m = renderTemplate("reminder_24h", { date: "Mon 7 Jan", time: "08:00", link: "https://x/portal" });
  expect(m.text).toContain("08:00"); expect(m.text).toContain("https://x/portal");
  expect(m.text).not.toMatch(/therap|diagnos|psycholog|session notes/i);
});
```
- [ ] **Step 2: Implement** templates with neutral wording ("You have an appointment on {date} at {time}. Manage it here: {link}").
- [ ] **Step 3: Cron route** `GET /api/cron/reminders` requires header `Authorization: Bearer ${CRON_SECRET}`; (a) enqueues `reminder_24h` for appointments starting in 23–25 h without an existing outbox row, (b) sends up to 50 `pending` rows with `send_after <= now()` through the provider, increments `attempts`, marks `sent`, or `failed` after 3 attempts. Overdue invoices create a task once (`source='overdue_invoice'`). Configure Vercel cron in `vercel.json` (`*/15 * * * *`).
- [ ] **Step 4: Run** `npm run test:unit`. **Step 5: Commit** `git commit -am "feat(notify): outbox, privacy-safe templates, cron"`

---

### Task 16: Dashboard, tasks, reports, settings, audit viewer

**Files:**
- Create: `app/app/page.tsx`, `app/app/tasks/page.tsx`, `app/app/reports/page.tsx`, `app/app/reports/export/route.ts`, `app/app/settings/page.tsx`, `app/app/settings/actions.ts`, `app/app/audit/page.tsx`, `lib/reports/queries.ts`, `lib/reports/ageing.ts`, `lib/reports/csv.ts`, `app/portal/page.tsx`, `app/portal/layout.tsx`, `app/app/layout.tsx`
- Test: `tests/unit/ageing.test.ts`, `tests/unit/csv.test.ts`

**Interfaces:**
- Produces: `ageingBucket(dueDate: string, today: string): "current"|"1-30"|"31-60"|"61-90"|"90+"`; `toCsv(rows: Record<string, string|number|null>[]): string` (RFC 4180, quotes fields containing comma, quote or newline, and prefixes cells beginning with `= + - @` with a single quote to block spreadsheet formula injection).

- [ ] **Step 1: Failing tests**

```ts
import { it, expect } from "vitest";
import { ageingBucket } from "@/lib/reports/ageing";
import { toCsv } from "@/lib/reports/csv";
it("buckets by days overdue", () => {
  expect(ageingBucket("2030-02-10", "2030-02-01")).toBe("current");
  expect(ageingBucket("2030-01-20", "2030-02-01")).toBe("1-30");
  expect(ageingBucket("2029-12-01", "2030-02-01")).toBe("61-90");
  expect(ageingBucket("2029-10-01", "2030-02-01")).toBe("90+");
});
it("escapes csv and blocks formula injection", () => {
  expect(toCsv([{ a: 'x,"y"', b: "=1+1" }])).toBe('a,b\n"x,""y""",\'=1+1');
});
```
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement**

```ts
// lib/reports/ageing.ts
export function ageingBucket(due: string, today: string) {
  const d = Math.floor((Date.parse(today) - Date.parse(due)) / 86400000);
  return d <= 0 ? "current" : d <= 30 ? "1-30" : d <= 60 ? "31-60" : d <= 90 ? "61-90" : "90+";
}
// lib/reports/csv.ts
const cell = (v: string | number | null) => {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(rows: Record<string, string | number | null>[]) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  return [keys.join(","), ...rows.map(r => keys.map(k => cell(r[k])).join(","))].join("\n");
}
```

- [ ] **Step 4: Dashboard** shows today's sessions, awaiting action (tentative bookings and submitted forms), outstanding invoices total, notes to complete, overdue accounts, unread items; every tile links to the relevant record. Tasks page: create, filter, complete, with priority and due date text labels.
- [ ] **Step 5: Reports** (`/app/reports`, role psychologist, admin, bookkeeper; bookkeeper sees financial reports only): income vs invoiced by month, debtors ageing, scheme vs patient outstanding, appointments (utilisation = booked minutes / available minutes, cancellations, no-show rate), new patients and referral sources. Date filters, definitions under each report, CSV export route per report (`/app/reports/export?report=…&from=…&to=…`) that audits `export.report`. Clinical outcomes analytics are not included in Phase 1; the page states this.
- [ ] **Step 6: Settings** (psychologist): practice details and crisis text, session types, working hours, blocked time, cancellation policy, approval mode, VAT, form template versions, staff roles listing (changes to roles are audited and done through SQL in Phase 1, shown read-only). Audit viewer (psychologist only) with filters by action, entity and date.
- [ ] **Step 7: Layouts and design.** Tokens in `app/globals.css`: sage `#7a9a86`, deep sage `#3f5f4d`, muted blue `#5b7fa6`, warm white `#faf8f4`, grey `#5c6168`; AA contrast verified; focus ring `outline: 3px solid var(--blue)`; status chips combine icon plus text. Staff layout: sidebar from 1024 px, bottom nav (Dashboard, Calendar, Patients, Tasks, More) on phones; portal layout: Home, Appointments, Documents, Payments, with the emergency disclaimer in the footer of every page. Use the `impeccable` and `frontend-design` skills for the visual pass.
- [ ] **Step 8: Run** `npm run test:unit; npm run typecheck; npm run lint`. **Step 9: Commit** `git commit -am "feat: dashboard, tasks, reports, settings, audit viewer"`

---

### Task 17: Hardening, e2e workflows, README and seed

**Files:**
- Modify: `next.config.ts`
- Create: `supabase/seed.sql` (fictional users and data, local only), `playwright.config.ts`, `tests/e2e/workflow-a.spec.ts`, `README.md`

- [ ] **Step 1: Security headers**

```ts
// next.config.ts
import type { NextConfig } from "next";
const csp = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "connect-src 'self' https://*.supabase.co", "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za", "frame-ancestors 'none'"].join("; ");
const config: NextConfig = {
  async headers() { return [{ source: "/(.*)", headers: [
    { key: "Content-Security-Policy", value: csp }, { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" }, { key: "Referrer-Policy", value: "same-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }] }]; },
};
export default config;
```
- [ ] **Step 2: Rate limiting** on login, booking and `/api/payfast/itn` is provided by Vercel's firewall rules (configured in the Vercel dashboard, listed in README); add a per-user server-side guard in `bookAppointment` limiting a patient to 5 active future bookings.
- [ ] **Step 3: Seed** with one psychologist, one admin, one bookkeeper (all with known local-only passwords noted in `supabase/seed.sql` comments and never reused for production), three fictional patients, availability Monday to Friday 08:00 to 16:00, three session types, one invoice per payer type. Marked "FICTIONAL, LOCAL ONLY".
- [ ] **Step 4: Workflow A e2e** — patient registers, books, completes consent forms, psychologist confirms, marks attended, writes and signs a note, generates an invoice, patient pays through the PayFast sandbox (or a test double that posts a signed ITN to the route), invoice shows paid, the report shows the income. Also workflow B (late cancellation creates a fee invoice) and an assertion that the admin account cannot open `/app/notes/<id>` (404).
- [ ] **Step 5: README** — local setup, role promotion SQL, environment variables, deployment steps (Task 18), backup and restore drill, incident escalation outline, go-live checklist copied from spec section 11.
- [ ] **Step 6: Run everything** `npm run typecheck; npm run lint; npm run test:unit; npm run test:db; npx playwright test`. Expected: all pass.
- [ ] **Step 7: Commit and push** `git add -A; git commit -m "feat: hardening, e2e workflows, docs"; git push`

---

### Task 18: Deploy (needs owner-created accounts)

**Files:** none (configuration and commands). Owner prerequisites: Supabase project, Vercel account, PayFast sandbox account, email provider (optional).

- [ ] **Step 1: Link and push schema** (owner runs `supabase login` and `vercel login`, since these need their credentials)

```powershell
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
```
Do not run `supabase/seed.sql` against production.
- [ ] **Step 2: Create the first staff account** in the Supabase dashboard, then in the SQL editor: `update profiles set role='psychologist', display_name='<name>' where user_id='<uuid>';` The psychologist enrols TOTP at first sign-in.
- [ ] **Step 3: Deploy**

```powershell
npx vercel link
npx vercel env add NEXT_PUBLIC_SUPABASE_URL production   # repeat for each variable in .env.example
npx vercel --prod
```
Set `APP_URL` to the production URL, `PAYFAST_SANDBOX=true` until go-live, and `CRON_SECRET` to a random 32-byte value. In Supabase Auth set the Site URL and redirect URLs to the production URL and enable email confirmation.
- [ ] **Step 4: Smoke test the live URL** — register a test patient, book, receive the confirmation row in the outbox, sign in as the psychologist with MFA, confirm the appointment, create and pay a sandbox invoice, verify the ITN arrives (PayFast sandbox posts to `/api/payfast/itn`), then delete the test records through the dashboard.
- [ ] **Step 5: Report** the production URL and the remaining go-live checklist items to the owner. The system must not store real patient data until the checklist in spec section 11 is complete.

---

## Self-review notes (spec coverage)

- Roles and matrix: Tasks 2 to 7. Booking and conflicts: Tasks 3, 9, 10. Forms and per-purpose consent: Tasks 5, 11. Notes with sign, version and addenda: Tasks 4, 12. Payments, PayFast, manual payments: Tasks 6, 13. Medical aid, ICD-10, claims, remittance, patient portion: Tasks 6, 14. Reminders: Task 15. Dashboard, tasks, reports, audit, settings: Task 16. Security headers, MFA, deployment, go-live: Tasks 8, 17, 18.
- Partial online payment is not offered (full outstanding balance only); partial payments arrive through manual and medical-aid recording. This narrows the spec's "partial payments" to the recorded methods and should be noted to the owner.
- Telehealth, messaging, treatment plans, accounting integrations and native apps are intentionally absent (Phase 2 and 3).
