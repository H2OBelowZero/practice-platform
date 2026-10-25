# Practice Platform

Practice-management web app for a private psychologist practice in South Africa: online booking, intake forms and consent, clinical notes, invoicing, card and medical-aid payments, reports, a patient portal and an audit trail. Next.js 15 (App Router) on Vercel, Supabase (Postgres, Auth, row-level security) behind it.

Where to read what: this README is the map and the runbook (build, test, deploy, go live, operate). `docs/decisions.md` explains the choices in plain language for the practice owner. `docs/reference.md` holds the per-subsystem detail (sign-in, PayFast, notifications, dashboard, security headers, dependencies). The design is in `docs/superpowers/specs/`, the build plan in `docs/superpowers/plans/`.

**Contents:** 1 Status - 2 Architecture and security - 3 Roles - 4 Local development - 5 Testing - 6 Deployment - 7 First staging run checklist - 8 Go-live checklist - 9 Operations - 10 Known limitations - 11 Where things are

## 1. What this is, and its status

Phase 1 of the spec is built: every item in section 2 of the design (auth with TOTP for staff, roles, settings, patients, booking and calendar, forms and consents, clinical notes, billing with PayFast and manual payments, medical-aid claim tracking, reminders, dashboard and tasks, reports, audit log, patient portal).

**Honest status: the application has never run against a live Supabase project.** There is no Docker or Supabase on the development machine, so everything below was verified by: TypeScript and lint, ~1 470 unit tests, ~620 database tests that run the real migrations on a throwaway PostgreSQL (with a stub of Supabase's `auth` schema), a production build, and a browser smoke test of the anonymous pages. What has **not** been exercised is listed in section 7: that list is the work still to do on the first staging project, and it is the gate before any real patient data is stored. This build is not legal or security certification; POPIA, PAIA and HPCSA obligations must be verified by the practice (section 8).

## 2. Architecture and security model

- **Runtime.** One Next.js codebase serves the staff workspace (`/app`), the patient portal (`/portal`), public booking (`/book`) and the sign-in pages. Server components and server actions do the work; the browser holds no database credentials beyond the public anon key. Money is integer cents (ZAR); times are `timestamptz`, the practice time zone is `Africa/Johannesburg`.
- **Authorisation is enforced twice.** (1) Postgres row-level security on every table (a DB test fails if a public table lacks RLS) plus guard triggers that make the business rules unbreakable even for the service role: appointment and invoice and claim state machines, immutable signed notes and submitted forms, append-only ledger/audit tables, no deletes of clinical or financial records. (2) Every `/app` and `/portal` page, server action and route handler calls `requireRole` / `requireUser` itself (`lib/auth/session.ts`); middleware only refreshes the session and sends anonymous visitors to `/login`. A unit test (`tests/unit/authz-coverage.test.ts`) fails, naming the file, if any page, action or route does not await such a call before touching data, or does so conditionally.
- **The service-role key** (bypasses RLS) is used only for: the audit writer `audit_append`, the PayFast notification, the cron worker, and the outbox. Never for a user-initiated read.
- **Staff must pass TOTP** (aal2) before any staff page renders. Patients and guardians use email and password. Staff accounts are created by the owner, never by sign-up (the signup trigger always makes a `patient`).
- **Money moves only through the database.** Payments are recorded by `record_payment` / `record_scheme_remittance`; invoices go draft, issued, part paid, paid or void by trigger; PayFast is trusted only through its server-to-server notification (ITN: signature, source IP, merchant id, amount, PayFast's own validate), never the browser return page.
- **Notifications** are rows in an outbox sent by a scheduled worker; messages hold only a date, a time and one link, and never reveal mental-health context.
- **Browser protections.** Nonce-based Content-Security-Policy per request, HSTS, `nosniff`, referrer and permissions policies, `X-Frame-Options: DENY`, `Cache-Control: no-store` on everything signed-in, error pages that never show internals, `noindex` on private areas.
- **Audit.** Logins, record views, note signing, exports, permission and settings changes and payment events are written to an append-only `audit_log` (psychologist can read). Settings tables have database audit triggers that store field names, never values.
- **Privacy of clinical data.** Clinical notes are readable only by the psychologist (not the admin, not the bookkeeper); the health-history form is hidden from the admin; the bookkeeper sees amounts but no names or diagnosis codes.

## 3. Roles and what each can do

| Area | Psychologist | Admin (receptionist) | Bookkeeper | Patient | Guardian |
| --- | --- | --- | --- | --- | --- |
| Dashboard, tasks | yes | yes (no notes tile, no clinical-risk tasks) | redirected to Billing | no | no |
| Patients and records | write | write | no (404) | own | linked child, per permission |
| Calendar, appointments | write | write | no | own (book, move, cancel) | child (needs `book`) |
| Forms and consents | request, read, return | request, read (not the health history) | no | own | child (needs `forms`) |
| Clinical notes | write, sign, addendum | **none (404)** | **none (404)** | none | none |
| Invoices and payments | write, record, credit notes | write, record (no credit notes) | read, no patient names | own, pay online | child's (needs `pay`) |
| Medical-aid members and claims | write incl. ICD-10 | write, no ICD-10 | amounts and status only | own membership | child's |
| Reports | all four | no Compliance | Financial only | no | no |
| Settings | write | read-only (blocked time editable) | no (404) | no | no |
| Audit log | read, export | none (404) | none (404) | none | none |

Anyone outside a page's role list gets a 404 (the area is not revealed); anonymous visitors are sent to `/login`. Patient and guardian sign-up is open; staff roles are assigned only by SQL (section 6.5). The `associate` role exists in the schema but has no UI in Phase 1.

## 4. Local development

**Without Docker (what unit and database tests need).** Node 22 or newer.

```
npm ci
cp .env.example .env.local     # only needed to run the app; tests do not read it
npm run typecheck && npm run lint
npm run test:unit              # Vitest, tests/unit
npm run test:db                # Vitest, tests/db: starts a throwaway PostgreSQL (embedded-postgres), applies supabase/test_bootstrap.sql then every migration
```

On Windows, if the repository path contains `&`, `npm run` breaks under `cmd.exe`; use Git Bash, or in PowerShell set `$env:npm_config_script_shell = "C:\Program Files\Git\bin\bash.exe"` first.

**The full stack (needs Docker).** `npx supabase start` (Postgres 17, Auth, API, Studio, a mail catcher at http://127.0.0.1:54324), then `npx supabase db reset`: it applies every migration and `supabase/seed.sql` (form templates **and** the demo data, see below). Put the URL and keys from `npx supabase status` into `.env.local`, then `npm run dev`. `supabase/config.toml` already sets: email confirmation on, TOTP enrol and verify on, minimum password length 12, `jwt_expiry` 3600, `secure_password_change` on.

**Demo data (`supabase/seed.sql`, below the generated form templates).** FICTIONAL, LOCAL/STAGING ONLY. Seven accounts with one shared, publicly documented password (`Demo-Passw0rd-2026`): `psychologist@demo.test`, `admin@demo.test`, `bookkeeper@demo.test`, `patient.a@demo.test` (Thandi Nkosi), `patient.b@demo.test` (Pieter van der Merwe, medical aid), `patient.c@demo.test` (Aisha Patel, prospect), `guardian@demo.test` (guardian of the minor Sipho Dlamini). Plus: practice "Demo Practice" (request-approval mode, 24 h window, R350 late fee), Monday to Friday 08:00 to 16:00, three session types (Initial consultation R1 200, Follow-up R950, Video follow-up R950), seven appointments (attended, confirmed, a tentative request, one cancelled with its fee task), submitted consent forms for patient A, a part-paid self-pay invoice (R400 EFT of R950), a split invoice with a submitted claim, the minor's unpaid invoice and a note draft. **Safety guard:** the demo block runs only when `auth.users` is empty **and** the practice is still named "My Practice"; on any configured database it only prints a notice, so loading the file on production is a no-op. It is not applied by `supabase db push` (that never seeds).

**Staff TOTP cannot be seeded.** Sign in as `psychologist@demo.test`; the app sends you to `/mfa`; press "Set up authenticator app", scan the QR with any authenticator app (or type the shown key into one), enter the 6-digit code. Repeat for `admin@demo.test` and `bookkeeper@demo.test`. The e2e suite does this automatically (section 5).

**Environment variables** (`.env.example` lists them all; a unit test fails if code reads one that is missing there):

| Variable | Used by | Secret? |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser and server clients, middleware, CSP. **Baked in at build time.** | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser and server clients | no (public by design) |
| `SUPABASE_SERVICE_ROLE_KEY` | audit writes, PayFast ITN, cron worker | **yes** |
| `APP_URL` | emailed links, PayFast return/notify URLs; required in production | no |
| `PAYFAST_MERCHANT_ID` | checkout, ITN merchant check | no |
| `PAYFAST_MERCHANT_KEY` | checkout | **yes** |
| `PAYFAST_PASSPHRASE` | checkout and ITN signatures; required outside the sandbox | **yes** |
| `PAYFAST_SANDBOX` | `true` = sandbox host; anything else = live | no |
| `CRON_SECRET` | authorises `/api/cron/reminders` | **yes** |
| `EMAIL_API_KEY`, `EMAIL_FROM` | outgoing email (Resend adapter) | key: **yes** |
| `SMS_ACTIVE` | `true` only when an SMS provider exists (none in Phase 1) | no |
| `E2E_*` | Playwright only (section 5) | service key: **yes** |

## 5. Testing

| Layer | Command | What it covers | Needs |
| --- | --- | --- | --- |
| Static | `npm run typecheck`, `npm run lint` | types, lint | nothing |
| Unit | `npm run test:unit` | validation, slot generation, fee and billing maths, PayFast signing and ITN logic, CSP and headers, notification templates, page rendering, the authorisation tripwire, `.env.example` coverage, the e2e helpers (TOTP against RFC 6238 vectors) | nothing |
| Database | `npm run test:db` | the real migrations on plain PostgreSQL: RLS isolation per role, state machines, immutability, billing/claims rules, outbox worker, reports, settings audit, TRUNCATE hardening, the demo seed (`tests/db/demo-seed.test.ts`) | nothing (embedded PostgreSQL) |
| End-to-end | `npm run test:e2e` | the workflows across roles in a real browser: A new patient to paid invoice, B reschedule/cancel and the late fee, C payments and reconciliation, the role matrix, plus the older per-feature specs | running app + seeded Supabase |
| Build | dummy-env `npm run build` (CI does it) | compiles | dummy variables |

**What the stub means.** The database tests replace Supabase's `auth` schema with a small stub (`supabase/test_bootstrap.sql`: roles, `auth.users`, `auth.identities`, `auth.uid()`), so Supabase Auth behaviour itself (MFA, the signup trigger on the real `auth.users`, email confirmation and recovery tokens, PostgREST query encoding) is verified only after deployment: section 7.

### Running the end-to-end tests

The suite cannot run without a Supabase project: with no `E2E_SUPABASE_*` variables every spec skips itself with a message, so `npx playwright test` exits 0 (all skipped). Use a **throwaway staging project or a local Supabase, never production**: the setup signs in with public demo passwords and writes test rows.

Environment (see `.env.example`): `E2E_BASE_URL` (default `http://localhost:3000`), `E2E_SUPABASE_URL`, `E2E_SUPABASE_ANON_KEY`, `E2E_SUPABASE_SERVICE_KEY`; optional `E2E_PASSWORD` (default: the seed's), `E2E_PAYFAST_PASSPHRASE` and `E2E_PAYFAST_MERCHANT_ID` (enable the "signed notification from a non-PayFast address is refused" check), `E2E_ADMIN_CREATE_PATIENT=1` (create the workflow-A patient through the admin API instead of `/register`; a hosted project's default email sender allows only a few messages an hour), `E2E_START_SERVER=1` (start `npm run dev` for the run).

**Against a staging project:**

```
# 1. staging Supabase: migrations pushed (section 6.3), then load the demo data once in the SQL editor
#    (paste supabase/seed.sql; it does nothing if the project already has users or a named practice)
# 2. an app pointed at that project: a Vercel preview deployment of this branch, or locally with .env.local holding the staging URL and keys
npx playwright install chromium                 # once
export E2E_BASE_URL=https://your-preview.vercel.app   # or http://localhost:3000 with `npm run dev` running
export E2E_SUPABASE_URL=https://<ref>.supabase.co
export E2E_SUPABASE_ANON_KEY=<anon key>
export E2E_SUPABASE_SERVICE_KEY=<service role key>
npm run test:e2e
npx playwright show-report
```

**Against a local Supabase:**

```
npx supabase start && npx supabase db reset                      # migrations + seed
npx supabase status -o env                                       # copy API_URL, ANON_KEY, SERVICE_ROLE_KEY
export E2E_SUPABASE_URL=http://127.0.0.1:54321 E2E_SUPABASE_ANON_KEY=... E2E_SUPABASE_SERVICE_KEY=...
export E2E_START_SERVER=1      # .env.local must hold the same URL and keys for `npm run dev`
npm run test:e2e
```

What the run does. **Global setup** (`tests/e2e/global-setup.ts`) signs in each seeded role through the real `/login` page; for staff it goes on to `/mfa`, sets up the authenticator the first time (the page shows the key as text), saves the key in `tests/e2e/.auth/totp-<role>.json`, and computes codes with a small RFC 6238 implementation (`helpers/totp.ts`, no dependency). Storage states land in `tests/e2e/.auth/<role>.json` (gitignored). If a staff user already has an authenticator that the suite did not create, remove that factor in the dashboard first. Setup then prepares the few rows the older specs expect and exports their ids. **Projects:** `chromium-desktop` runs everything; `chromium-mobile` (375 x 812) runs only tests tagged `@mobile`. **Specs:** `workflow-a/b/c.spec.ts`, `access.spec.ts` plus the twelve earlier per-feature specs. **PayFast:** the ITN route checks the caller's address against PayFast's ranges, which a test cannot fake on Vercel, and production code is not weakened for tests. So the workflows perform the ITN step at database level, with the same `record_payment` call the route makes after its checks (`helpers/itn.ts`); the signature/IP/validate logic is covered by unit and DB tests, and one e2e check proves a correctly signed notification from a non-PayFast address gets 400. **State:** the workflow specs create their own uniquely named patients; several older specs mutate the demo rows and are not re-runnable on the same data, so for a clean full run use a fresh staging project, or `supabase db reset` locally. Retries: 1 in CI, trace on first retry, one worker.

## 6. Deployment, step by step (the owner does these)

You need accounts with: Supabase, Vercel, GitHub (the repository), PayFast (sandbox first, live later) and an email provider. Nothing here needs the demo data. Do a complete staging run (section 7) before the production project holds real data.

**6.1 Create the Supabase project.** Choose the region closest to South Africa (Africa/Cape Town if offered, otherwise the nearest European region). Where the servers are matters legally: personal and health information leaves South Africa when it is stored abroad, which is a cross-border transfer under POPIA section 72; record the region and your legal basis (section 8). Use a strong database password (a password manager). Choose a paid plan before real data: daily backups, point-in-time recovery, session time limits and custom SMTP need it.

**6.2 Link the CLI.** `npx supabase login`, then `npx supabase link --project-ref <ref>`.

**6.3 Apply the migrations, not the seed.** `npx supabase db push` applies `supabase/migrations/0001` to `0029` in order. It does not run `seed.sql` and you must not paste the demo data into production. The form templates (wording is a DRAFT) are the generated block at the top of `seed.sql`; load only that block, and only after the practice and a legal advisor have reviewed the wording (section 8). Then, in the SQL editor, run this verification query (migration 0029 removes dangerous privileges from the API roles; a test runs this exact text) and expect **zero rows**:

```sql
-- tables, views, materialized views and partitioned tables; expect zero rows
select c.relname, c.relkind, r.rolname, p.priv
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
cross join (values ('TRUNCATE'), ('TRIGGER'), ('REFERENCES'), ('MAINTAIN')) p(priv)
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
  and case when p.priv = 'MAINTAIN' and current_setting('server_version_num')::int < 170000 then false
           else has_table_privilege(r.rolname, c.oid, p.priv) end;
```

If it returns rows (tables made in Supabase Studio belong to `supabase_admin` and have their own default privileges), see `docs/reference.md`, "TRUNCATE (R20)": re-run the idempotent 0029 `DO` block and apply the `alter default privileges for role supabase_admin` statement given there.

**6.4 Create the first staff user.** Dashboard > Authentication > Users > Add user: the owner's email, a password of at least 12 characters, "Auto Confirm User" on.

**6.5 Promote them.** SQL editor:

```sql
update profiles set role = 'psychologist' where user_id = (select id from auth.users where email = 'owner@example.com');
-- other staff: 'admin' (receptionist), 'bookkeeper'. Never promote anyone by metadata: the app ignores it.
```

Then the owner signs in and sets up the authenticator at `/mfa`. Whoever creates a staff account should be present at that first sign-in: until a verified factor exists, anyone holding the password could enrol their own authenticator.

**6.6 Auth settings** (Authentication in the dashboard; `supabase/config.toml` documents the same values for local use):
1. Providers > Email: enable **Confirm email** (this is a security control: the patient-record linking relies on a confirmed address), **Secure email change**, **Secure password change**, minimum password length **12**.
2. Multi-factor: enable **TOTP** (enrol and verify).
3. URL configuration: Site URL = `APP_URL`; add `APP_URL/auth/callback` to the redirect allow-list (password-reset links land there).
4. Custom SMTP (Project Settings > Auth > SMTP) with the practice's email provider and a verified sender domain. The built-in sender is rate-limited and meant for testing; sign-up confirmations and password resets go through it otherwise.
5. Sessions (Pro): set a **time-box** and an **inactivity timeout** so idle staff sessions expire (the bank-detail edit relies on the multi-factor session, see `docs/decisions.md`).

**6.7 Vercel.** Import the GitHub repository (framework Next.js, defaults). Set the environment variables below for **Production**; give **Preview** deployments a *staging* project's values, never production's. `NEXT_PUBLIC_SUPABASE_URL` (and the anon key) must exist **before the build**: they are inlined at build time and the Content-Security-Policy is built from the URL; if it is missing the app answers 500 by design. After changing a `NEXT_PUBLIC_*` value, redeploy.

| Variable | Production value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Project Settings > API |
| `APP_URL` | the public origin, e.g. `https://practice.example.co.za` (no trailing slash) |
| `CRON_SECRET` | `openssl rand -hex 32` |
| `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_SANDBOX` | section 6.9 |
| `EMAIL_API_KEY`, `EMAIL_FROM` | section 6.8 (the Resend adapter ships as a placeholder; confirm the provider) |
| `SMS_ACTIVE` | leave unset (no SMS provider in Phase 1) |

**6.8 Email.** Pick a provider, verify the sending domain (SPF, DKIM), create an API key, set `EMAIL_API_KEY` and `EMAIL_FROM` (`Bookings <bookings@yourdomain.co.za>`). Without both, production sends nothing and rows stay pending. Sign the POPIA operator agreement with it (section 8). A different provider needs one small class with a `send()` method (`lib/notify/provider.ts`).

**6.9 Cron.** `vercel.json` runs `/api/cron/reminders` every 15 minutes. **Vercel Hobby allows cron only once a day**, so 15-minute reminders need Pro. On Hobby either change the schedule to daily or remove the cron entry and call the route from an external scheduler: `curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP/api/cron/reminders`. With `CRON_SECRET` set on Vercel, Vercel sends that header itself.

**6.10 PayFast.** Create a sandbox account (sandbox.payfast.co.za). Settings > Integration: note merchant id and key, set a **security passphrase**, enable ITN. Put them in the *staging* environment with `PAYFAST_SANDBOX=true`. The notify URL is built automatically as `APP_URL/api/payfast/itn` and must be public HTTPS, not redirected, not behind a login or a proxy other than Vercel. Test a sandbox payment end to end (section 7). For live: a live merchant account, its own id, key and passphrase (the passphrase must match the dashboard exactly), `PAYFAST_SANDBOX` unset or `false`, redeploy, and re-check the IP ranges against PayFast's documentation (`PAYFAST_IP_RANGES`). Add Vercel firewall rate-limit rules for `/login`, `/book` and `/api/payfast/itn` (care: never block PayFast's addresses).

**6.11 Domain.** Add the custom domain in Vercel, set DNS, then update `APP_URL`, the Supabase Site URL and redirect list, and the PayFast settings, and redeploy. HSTS is sent with `includeSubDomains` for two years: use a domain whose subdomains are all HTTPS.

## 7. First staging run checklist

Tick each line on the staging project (migrations pushed, demo seed loaded, app deployed or run locally against it). Items marked (E2E) are also exercised by the Playwright suite, which still needs its first real run. **This list is every "unverified until deploy" item the build accumulated.**

**Database and Auth**
- [ ] 1. `db push` applies all 29 migrations without error on real Supabase (PostgreSQL 17; extension schemas, `supabase_admin` ownership). Fix forward with a new migration, never by editing a pushed file.
- [ ] 2. Demo seed loads on the empty staging project and the demo accounts can sign in (the seed writes `auth.users` and `auth.identities` rows by hand: check password login, no "database error querying schema").
- [ ] 3. The signup trigger on the real `auth.users` creates a `patient` profile for a new sign-up and ignores a `role` in the sign-up metadata. Register a test patient (E2E, workflow A).
- [ ] 4. "Confirm email" is on: an unconfirmed account cannot sign in; `ensure_patient_record()` links an existing record only for a confirmed, invited, single-match address.
- [ ] 5. Password recovery end to end: the verified token's `amr` shows method `recovery` (`lib/auth/recovery.ts` assumes this shape); a patient resets; a staff user must pass TOTP first; an ordinary session cannot reach `/recover/reset`.
- [ ] 6. TOTP: enrol and verify at `/mfa` upgrades the cookie session to aal2 inside the server action, and the redirect to `/app` does not bounce back to `/mfa` (E2E global setup). A wrong code is refused.
- [ ] 7. Default-privilege check: run the verification query from section 6.3 on staging: zero rows. Re-run after creating any table in Studio; apply the `supabase_admin` default-privilege statement there if rows appear.
- [ ] 8. `audit_log` receives rows through `audit_append` as the service role (sign in, view a patient, sign a note, change a setting) and the psychologist sees them in `/app/audit`; a patient cannot write or read audit rows.
- [ ] 9. Session time-box and inactivity timeout are set (6.6) and an idle staff session expires.

**PostgREST and the app's queries** (the database tests cannot see these)
- [ ] 10. Patient search and list filters (`.or()` groups with quoted values containing commas, quotes and percent signs) return the right rows.
- [ ] 11. Keyset paging in the audit viewer and CSV export: cursor timestamps (microseconds, time zone offset) neither skip nor repeat rows; `nullsFirst` ordering; a page past the end returns an empty page, not an error (PGRST103).
- [ ] 12. RPC arguments: `p_by: null`, a jsonb array (`create_invoice_draft` / `save_invoice_draft` `p_lines`), a `text[]` (`claim_outbox`) are accepted as sent.
- [ ] 13. Aggregates serialise as numbers the app expects (`billing_totals`, `report_*`: PostgREST returns `bigint` and `numeric`); a `too_many_rows` error shows the intended message.
- [ ] 14. Form and note draft autosave: the `updated_at` equality filter matches the stored timestamp (encoding and precision); a second tab gets the conflict message. The audit tab's `detail->>patient_id` filter works.
- [ ] 15. React 19 `useActionState` + `redirect()` flows complete and show their notices: form submit, consent withdrawal, checkout start, booking confirm, cancel and reschedule (E2E).

**Payments**
- [ ] 16. PayFast sandbox payment end to end: the checkout form is accepted (field order, signature without empty values); the ITN arrives from a PayFast address; the signature verifies (do ITN signatures include empty fields? `lib/payments/payfast.ts` assumes yes); the IP ranges are current; PayFast `validate` answers VALID; one `payments` row `PF-<id>`; the invoice shows paid; a resend is a no-op; the browser return URL shows stored status only.
- [ ] 17. The unreconciled path: pay an invoice twice or after a credit note; one staff task "PayFast payment needs reconciliation" appears and no money is recorded.
- [ ] 18. `Referrer-Policy: strict-origin-when-cross-origin` and the CSP `form-action` allow the PayFast POST and its redirect chain without console violations.
- [ ] 19. A wrongly signed or non-PayFast-address ITN gets 400 (the e2e check, with `E2E_PAYFAST_PASSPHRASE`).

**Email and scheduling**
- [ ] 20. The email provider sends a booking confirmation and a 24-hour reminder; the footer shows only the generic emergency line; stale rows expire instead of sending.
- [ ] 21. The cron route: Vercel (or the external scheduler) calls it with `Authorization: Bearer <CRON_SECRET>`; a call without it gets 401; a run writes one `cron.reminders.run` audit row when something happened.

**Browser and accessibility**
- [ ] 22. CSP: open the key signed-in screens with the console open and expect no violations: booking slot picker, forms editor with autosave, note editor, calendar, billing, Radix dialogs/selects/tabs, the `/mfa` QR image. Check the response headers on Vercel (HSTS, CSP, Cache-Control `no-store`; Vercel may add or override headers).
- [ ] 23. Phone width (375 px) and keyboard-only pass of: sign in, booking, portal forms, payments, the staff calendar, note editor. A screen-reader pass (landmarks, form errors, status messages, the slot picker).
- [ ] 24. Time zone: appointment times, reminders and invoice dates show South African time on Vercel (server in UTC).

**Suite and process**
- [ ] 25. `npm run test:e2e` is green for both projects against staging (section 5); record the date and commit.
- [ ] 26. Vercel firewall rate limits are in place (6.10), preview deployments point at staging only.
- [ ] 27. A backup restore has been done once on staging and timed (section 9).

## 8. Go-live checklist

Required before **real patient data** is stored (design spec section 11 and open items in section 12). Owner tasks are marked (owner). The spec's go-live list has six lines and its open items four; they are expanded here into twelve rows with the evidence to keep.

| # | Item | Evidence / who |
| --- | --- | --- |
| G1 | Patient-isolation and role tests pass against the production configuration | `npm run test:db` green on the release commit; `access.spec.ts` and the workflows green against staging (check 25); the tripwire test green |
| G2 | A backup restore has been performed and documented | Restore drill record (section 9): date, who, time taken, what was checked (owner) |
| G3 | Incident escalation procedure written | Section 9 outline adapted with real names and numbers (owner) |
| G4 | Consent forms, privacy notice and cancellation terms reviewed by the practice and a legal advisor | Final wording replaces the DRAFT templates in `lib/forms/templates.ts` (then `UPDATE_SEED=1 npm run test:unit`, new template **version**, never edit a used one) (owner + advisor) |
| G5 | Information Officer named (POPIA) and registered with the Information Regulator | Name and registration reference on file (owner) |
| G6 | PAIA manual in place | Document published (owner) |
| G7 | POPIA operator agreements signed with Supabase, Vercel, PayFast and the email provider | Signed copies filed (owner) |
| G8 | Data region and cross-border transfer position confirmed | Region from 6.1 recorded with the legal basis for the transfer (POPIA s72) (owner + advisor) |
| G9 | Staff MFA verified for every staff account | For each staff user the dashboard shows a verified TOTP factor; a sign-in without a code fails (owner) |
| G10 | Crisis procedure text final | Edited in Settings > Practice, shown in the portal and booking confirmation (owner) |
| G11 | Retention periods confirmed (nothing is deleted automatically in Phase 1) | Settings > Retention filled in with the advisor's periods and any legal hold (owner) |
| G12 | Technical gate | Section 7 fully ticked; live PayFast credentials, passphrase and IP ranges confirmed; email provider live; session timeout set; `PAYFAST_SANDBOX` not `true`; demo data absent (`select count(*) from auth.users where email like '%@demo.test'` = 0) |

Do not store real patient data until every row is done.

## 9. Operations

**Backups and the restore drill.** Free-tier projects have no usable backups: use a paid plan (daily backups; add point-in-time recovery if the practice cannot afford to lose a day). Also take your own copy: `npx supabase db dump --linked -f backup.sql` (schema) and `... --data-only` for data, kept encrypted off-site. Drill, at least before go-live and then twice a year: (1) restore the latest backup into a **new** project (dashboard > Database > Backups, or load the dump with `psql`), never over production; (2) apply nothing else; (3) check row counts of `patients`, `appointments`, `invoices`, `payments`, `clinical_notes`, `audit_log` against production, open a signed note, and run the section 6.3 query; (4) sign in with a test staff account (TOTP factors live in Auth and come with an Auth restore; confirm); (5) record the date, the time it took, and what failed; (6) delete the drill project (it holds real data).

**Incident response (outline; write the real names and phone numbers in).** *Detect:* an alert, an odd audit entry, a patient report, a provider notice. *Contain:* disable the affected user in Supabase Auth and sign out all their sessions, rotate the credentials involved (below), take the affected feature offline if needed, preserve logs (Vercel, Supabase, `audit_log`; do not delete). *Assess:* what personal information, whose, how many people, since when; use the audit viewer and the provider logs. *Notify:* POPIA section 22 requires telling the Information Regulator and the affected data subjects as soon as reasonably possible after the compromise is discovered, when there are reasonable grounds to believe personal information was accessed by an unauthorised person (describe what happened and the steps people can take; follow the Regulator's current process; take the advisor's guidance on wording and timing). Notify the HPCSA or insurer if your policy requires it. *Document:* a dated record of facts, decisions, notifications and fixes; review what to change. Keep a call list: Information Officer, legal advisor, insurer, Supabase/Vercel/PayFast support.

**Data-subject requests (access, correction, deletion) are manual in Phase 1.** Log the request as a task (Tasks > New) and answer within the POPIA/PAIA time limits with your Information Officer. *Access:* export what the person is entitled to: profile, appointments, forms and consents, invoices and payments (staff screens, the CSV exports), and, for clinical notes, the psychologist decides what is released (health records have their own rules; take advice). *Correction:* staff can correct profile and contact data; a signed note is never edited, a correction is an addendum; a submitted form is returned to the patient to correct. *Deletion:* the application has no delete function and the database refuses deletion of appointments, notes, forms, consents, invoices, payments and audit rows (professional and tax record keeping). Patients can be archived. If erasure of something is legally required, it needs a reviewed, one-off SQL procedure agreed with the advisor, recorded in the audit trail; never delete ad hoc. *What is kept and why:* clinical, billing and consent records for the statutory retention period; the audit log as evidence.

**Key and secret rotation.** *Supabase anon/service keys:* Project Settings > API (rotating the JWT secret invalidates all sessions and both keys); update Vercel, redeploy. *`CRON_SECRET`:* change it in Vercel and in any external scheduler together. *PayFast passphrase:* change it in the PayFast dashboard and in Vercel at the same moment (notifications between the two fail and are retried by PayFast); same for merchant key. *Database password:* Settings > Database (the app does not connect directly; only your CLI and backups do). *Email key:* new key at the provider, update Vercel. Any `NEXT_PUBLIC_*` change needs a rebuild. Never commit secrets; `.env*` is git-ignored.

**Monitoring.** Check weekly: Vercel deployment and function error logs; Supabase logs and database health; uptime check on `/login`; the Tasks page (PayFast unreconciled payments, "Notification could not be sent", rejected claims, overdue invoices); the audit viewer for unexpected exports; Settings > Connections (cron, PayFast mode, email provider); GitHub Actions and Dependabot pull requests (`npm audit` gate, `.github/audit-allowlist.json`). Track the backup status.

## 10. Known limitations and deferred items

**Deferred to Phase 2/3 (spec section 2):** automated electronic medical-aid submission and remittance import (claims are tracked by hand), telehealth, secure messaging, treatment plans, document management beyond intake forms, patient refunds (PayFast refunds are done in its dashboard), accounting ledger/balance sheet and expenses/P&L (the accountant export is a transactions CSV), SMS and push (logged stubs; SMS reminders are off), card on file and partial online payments (checkout always bills the whole balance), calendar and accounting integrations, native apps, offline use, AI documentation, group/family sessions, multi-practitioner UI (the `associate` role is schema-only), waiting list, month calendar view, drag-and-drop rescheduling, automatic deletion by retention policy.

**Accepted design limits:** no step-up re-authentication for bank-detail edits (aal2 session, confirmation tick, review panel, audit rows instead); archived patients keep portal login; the patient reschedule keeps the booking's current status; a booking made by staff does not count against a patient's cap of five; manual refs and the over-payment guard rely on staff care for medical-aid versus patient responsibility; a partly-paid claim cannot be re-opened; emails never name conditions so they cannot carry clinical detail; Next.js 15 with advisories that only a Next 16 upgrade fixes (`docs/reference.md`, "Dependencies"); PNG app icons are missing (SVG only); `style-src` keeps `'unsafe-inline'`; CSP and cache headers on Vercel are unverified until check 22.

## 11. Where things are

```
app/                 Next.js routes: (public)/book, (auth)/login|register|mfa|recover, app/ (staff), portal/ (patients), api/payfast/itn, api/cron/reminders
components/          ui/ (Button, Field, StatusChip, Notice, SlotPicker...), shell/, calendar/, dashboard/, reports/, settings/, tasks/
lib/                 domain logic by area: auth, booking, appointments, billing, payments (payfast, itn), claims, notes, forms, notify, reports, settings, security (csp, headers), supabase clients
middleware.ts        session refresh, anonymous redirect, per-request CSP nonce
next.config.ts       static security headers, no-store rules
supabase/migrations  0001..0029, applied in order; supabase/seed.sql (form templates + guarded demo data); supabase/test_bootstrap.sql (test-only auth stub); supabase/config.toml
tests/unit           Vitest (no database)      tests/db  Vitest on embedded PostgreSQL      tests/e2e  Playwright (helpers/, global-setup.ts)
scripts/             audit-check.mjs (CI gate), e2e.mjs (npm run test:e2e wrapper)
docs/                decisions.md (plain language), reference.md (subsystems), superpowers/specs + plans
.github/             workflows/ci.yml, dependabot.yml, audit-allowlist.json
vercel.json          cron schedule
```

**Scripts:** `dev`, `build`, `start`, `lint`, `typecheck`, `test:unit`, `test:db`, `test:e2e`.

**Conventions.** A pushed migration is never edited: add the next-numbered file (tests pick it up with no wiring). Every new public table enables RLS (a test enforces it) and every `security definer` function revokes execute from `public` and `anon`. Money in integer cents, formatted by `lib/money.ts`. Every new page, action or route calls `requireRole`/`requireUser` first and awaits it. Form templates are written in `lib/forms/templates.ts`; after editing run `UPDATE_SEED=1 npm run test:unit` to regenerate the block between the markers in `seed.sql` (a test fails if they drift); change a form by inserting a new **version**. Emailed links use `appUrl()`. Anything new that reads an environment variable must be added to `.env.example`. Commit messages end with the co-author line used in this repository; work happens on `phase-1` and is pushed to `origin`. The internal rulings behind many of these rules are summarised in `docs/decisions.md`.

**Dependencies.** CI runs `node scripts/audit-check.mjs` (fails only on a new high/critical advisory not in `.github/audit-allowlist.json`); Dependabot opens weekly PRs. Known open advisories and why they are accepted are in `docs/reference.md`.
