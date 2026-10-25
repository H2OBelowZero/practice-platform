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

**The full stack (needs Docker).** `npx supabase start` (Postgres 17, Auth, API, Studio, a mail catcher at http://127.0.0.1:54324), then `npx supabase db reset`: it applies every migration and `supabase/seed.sql` (the DRAFT form templates only: no accounts, no personal data). The demo data is a separate file you load by hand (next paragraph). Put the URL and keys from `npx supabase status` into `.env.local`, then `npm run dev`. `supabase/config.toml` already sets: email confirmation on, TOTP enrol and verify on, minimum password length 12, `jwt_expiry` 3600, `secure_password_change` on.

**Demo data (`supabase/seed-demo.sql`, never loaded automatically).** FICTIONAL, for THROWAWAY local or staging databases ONLY. Seven accounts with one shared, publicly documented password (`Demo-Passw0rd-2026`): `psychologist@demo.test`, `admin@demo.test`, `bookkeeper@demo.test`, `patient.a@demo.test` (Thandi Nkosi), `patient.b@demo.test` (Pieter van der Merwe, medical aid), `patient.c@demo.test` (Aisha Patel, prospect), `guardian@demo.test` (guardian of the minor Sipho Dlamini). Plus: practice "Demo Practice" (request-approval mode, 24 h window, R350 late fee), Monday to Friday 08:00 to 16:00, three session types (Initial consultation R1 200, Follow-up R950, Video follow-up R950), seven appointments (attended, confirmed, a tentative request, one cancelled with its fee task), submitted consent forms for patient A, a part-paid self-pay invoice (R400 EFT of R950), a split invoice with a submitted claim, the minor's unpaid invoice and a note draft. Phones are obviously invalid (`000 000 ...`) and every address is on the reserved `.test` domain. It also holds a pure medical-aid invoice (patient portion R0).

**Loading it (explicit, on purpose).** `supabase/config.toml` lists only `seed.sql`, so `supabase db reset` and `db push` never load the demo file. After `db reset` (or after the staging migrations and `seed.sql`), run it in ONE session with the opt-in setting: locally `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "set app.demo_seed = 'on'" -f supabase/seed-demo.sql`; on a throwaway staging project paste `set app.demo_seed = 'on';` on the first line of the SQL editor, then the whole file, and run it as one script. It does nothing (it prints a notice) unless all four hold: the opt-in is set, `auth.users` is empty, the practice is still named "My Practice", and the form templates are loaded.

**NEVER on production.** The file creates a psychologist (and an admin, a bookkeeper and patients) whose password is printed in this README. The empty-database and default-name guards are true on a brand-new production project too, so they are not protection by themselves: the opt-in and this rule are. Because `supabase db reset --linked` **wipes and re-creates the linked remote database**, and `supabase db push --include-seed` runs `seed.sql` against it, never use either on production; the demo file is safe from them only because it is not in the config. Before go-live, prove no demo user exists (section 8, task O9).

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

Environment (see `.env.example`): `E2E_BASE_URL` (default `http://localhost:3000`), `E2E_SUPABASE_URL`, `E2E_SUPABASE_ANON_KEY`, `E2E_SUPABASE_SERVICE_KEY`; optional `E2E_PASSWORD` (default: the seed's), `E2E_PAYFAST_PASSPHRASE` and `E2E_PAYFAST_MERCHANT_ID` (enable the "signed notification from a non-PayFast address is refused" check), `E2E_ADMIN_CREATE_PATIENT=1` (create the workflow-A patient through the admin API instead of `/register`; a hosted project's default email sender allows only a few messages an hour), `E2E_START_SERVER=1` (start `npm run dev` for the run). `E2E_REQUIRE=1` makes the run FAIL (non-zero exit) when the three `E2E_SUPABASE_*` values are missing instead of skipping everything: set it in CI and staging gates, where a silent skip would look like a pass. As a safety stop, global setup also refuses to run unless the project's practice is named "Demo Practice", so the suite cannot be pointed at a real clinic by mistake.

**Against a staging project:**

```
# 1. throwaway staging Supabase: migrations pushed (section 6.3) and supabase/seed.sql loaded, then the demo data ONCE, explicitly:
#    SQL editor, one script:  set app.demo_seed = 'on';  followed by the contents of supabase/seed-demo.sql  (NEVER on a project that will hold real data)
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
npx supabase start && npx supabase db reset                      # migrations + seed.sql (templates)
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "set app.demo_seed = 'on'" -f supabase/seed-demo.sql
npx supabase status -o env                                       # copy API_URL, ANON_KEY, SERVICE_ROLE_KEY
export E2E_SUPABASE_URL=http://127.0.0.1:54321 E2E_SUPABASE_ANON_KEY=... E2E_SUPABASE_SERVICE_KEY=...
export E2E_START_SERVER=1      # .env.local must hold the same URL and keys for `npm run dev`
npm run test:e2e
```

What the run does. **Global setup** (`tests/e2e/global-setup.ts`) signs in each seeded role through the real `/login` page; for staff it goes on to `/mfa`, sets up the authenticator the first time (the page shows the key as text), saves the key in `tests/e2e/.auth/totp-<role>.json`, and computes codes with a small RFC 6238 implementation (`helpers/totp.ts`, no dependency). Storage states land in `tests/e2e/.auth/<role>.json` (gitignored). If a staff user already has an authenticator that the suite did not create, remove that factor in the dashboard first. Setup then prepares the few rows the older specs expect and exports their ids. **Projects:** `chromium-desktop` runs everything; `chromium-mobile` (375 x 812) runs only tests tagged `@mobile`. **Specs:** `workflow-a/b/c.spec.ts`, `access.spec.ts` plus the twelve earlier per-feature specs. **PayFast:** the ITN route checks the caller's address against PayFast's ranges, which a test cannot fake on Vercel, and production code is not weakened for tests. So the workflows perform the ITN step at database level, with the same `record_payment` call the route makes after its checks (`helpers/itn.ts`); the signature/IP/validate logic is covered by unit and DB tests, and one e2e check proves a correctly signed notification from a non-PayFast address gets 400. **State:** the workflow specs create their own uniquely named patients; several older specs mutate the demo rows and are not re-runnable on the same data, so for a clean full run use a fresh staging project, or `supabase db reset` locally. Retries: 1 in CI, trace on first retry, one worker. **Direct-API isolation (`access.spec.ts`, "direct API requests"):** the blueprint requires isolation "including through direct API requests", so these tests skip the website and call PostgREST with the project's anon key and a patient's own access token (password sign-in with supabase-js, held in memory only, never put in a browser): patient A must get zero rows or a permission error for patient B's patients, appointments, invoices, payments, forms and consents and for every clinical, claims, audit, task and outbox table, and the booking, payment, remittance, cancel and audit functions must refuse; the same for the bookkeeper and admin on clinical tables and for an anonymous caller. `tests/db/demo-seed.test.ts` runs the same expectations as SQL against the seeded schema.

## 6. Deployment, step by step (the owner does these)

You need accounts with: Supabase, Vercel, GitHub (the repository), PayFast (sandbox first, live later) and an email provider. Nothing here needs the demo data. Do a complete staging run (section 7) before the production project holds real data.

**6.1 Create the Supabase project.** Choose the region closest to South Africa (Africa/Cape Town if offered, otherwise the nearest European region). Where the servers are matters legally: personal and health information leaves South Africa when it is stored abroad, which is a cross-border transfer under POPIA section 72; record the region and your legal basis (section 8). Use a strong database password (a password manager). Check your plan before real data: backups and point-in-time recovery, session time-box and inactivity timeout and similar features depend on the plan (see Supabase's current pricing and plan pages); a free project is for staging only.

**6.2 Link the CLI.** `npx supabase login`, then `npx supabase link --project-ref <ref>`.

**6.3 Apply the migrations, not the seed.** `npx supabase db push` applies `supabase/migrations/0001` to `0029` in order. `db push` does not seed. **Never run `supabase/seed-demo.sql` on production** (public-password staff accounts; see section 4). Never use `supabase db reset --linked` (it wipes the linked remote database) or `supabase db push --include-seed` on production either. The form templates (wording is a DRAFT) are the generated block at the top of `seed.sql`; load only that block, and only after the practice and a legal advisor have reviewed the wording (section 8). Then, in the SQL editor, run this verification query (migration 0029 removes dangerous privileges from the API roles; a test runs this exact text) and expect **zero rows**:

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

If it returns rows (tables made in Supabase Studio belong to `supabase_admin` and have their own default privileges), see `docs/reference.md`, "Dangerous privileges (TRUNCATE)": re-run the idempotent 0029 `DO` block and apply the `alter default privileges for role supabase_admin` statement given there.

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
5. Sessions (check your plan): if your plan offers them, set a **time-box** and an **inactivity timeout** so idle staff sessions expire (the bank-detail edit relies on the multi-factor session, see `docs/decisions.md`).

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
- [ ] 15. PostgREST embeds and filters on them: `!inner` joins, reverse embeds and `head: true` exact counts (patients list, claims list, notes-to-complete, billing lists, dashboard tiles) return the right rows and counts, with row-level security applied to the embedded rows.
- [ ] 16. `update(...).select()` returns zero rows (not an error) under RLS for a role without write access: a settings or patient edit by such a role shows the intended "not allowed" message and never a false success.
- [ ] 17. The API row cap: the audit and report CSV exports assume at most 1 000 rows per response (the app reads in chunks of 1 000 with keyset paging). Confirm the project's max-rows setting is 1 000 or more and that a 5 000-row export is complete with no duplicate or missing row.
- [ ] 18. React 19 passes the clicked submit button's name and value in FormData: the slot-picker time buttons (`start`), reschedule and the multi-button forms act on the time or button actually pressed.
- [ ] 19. React 19 `useActionState` + `redirect()` flows complete and show their notices: form submit, consent withdrawal, checkout start, booking confirm, cancel and reschedule (E2E).

**Payments**
- [ ] 20. PayFast sandbox payment end to end: the checkout form is accepted (field order, signature without empty values); the ITN arrives from a PayFast address; the signature verifies (do ITN signatures include empty fields? `lib/payments/payfast.ts` assumes yes); the IP ranges are current; PayFast `validate` answers VALID; one `payments` row `PF-<id>`; the invoice shows paid; a resend is a no-op; the browser return URL shows stored status only.
- [ ] 21. The unreconciled path: pay an invoice twice or after a credit note; one staff task "PayFast payment needs reconciliation" appears and no money is recorded.
- [ ] 22. `Referrer-Policy: strict-origin-when-cross-origin` and the CSP `form-action` allow the PayFast POST and its redirect chain without console violations.
- [ ] 23. A wrongly signed or non-PayFast-address ITN gets 400 (the e2e check, with `E2E_PAYFAST_PASSPHRASE`).

**Concurrency and repetition**
- [ ] 24. Two browsers book the same slot at once: exactly one succeeds, the other sees "just taken" (`booking.spec.ts`).
- [ ] 25. A PayFast notification delivered twice (resend it from the sandbox dashboard): one payment row, one receipt.
- [ ] 26. Double-clicks and double submits on Pay now, form submit, record payment, issue invoice, cancel and confirm have a single effect (and the second click is harmless).

**Email and scheduling**
- [ ] 27. The email provider sends a booking confirmation and a 24-hour reminder; the footer shows only the generic emergency line; stale rows expire instead of sending.
- [ ] 28. The cron route: Vercel (or the external scheduler) calls it with `Authorization: Bearer <CRON_SECRET>`; a call without it gets 401; a run writes one `cron.reminders.run` audit row when something happened.

**Browser and accessibility**
- [ ] 29. CSP: open the key signed-in screens with the console open and expect no violations: booking slot picker, forms editor with autosave, note editor, calendar, billing, Radix dialogs/selects/tabs, the `/mfa` QR image. Check the response headers on Vercel (HSTS, CSP, Cache-Control `no-store`; Vercel may add or override headers).
- [ ] 30. Phone width (375 px) and keyboard-only pass of: sign in, booking, portal forms, payments, the staff calendar, note editor. A screen-reader pass (landmarks, form errors, status messages, the slot picker).
- [ ] 31. Time zone: appointment times, reminders and invoice dates show South African time on Vercel (server in UTC).

**Suite and process**
- [ ] 32. `npm run test:e2e` is green for both projects against staging (section 5); record the date and commit.
- [ ] 33. The direct-API isolation run is green against staging: `access.spec.ts` "direct API requests" (anon key + a patient's token; patient A, admin, bookkeeper and anonymous see no one else's or no clinical data, and the functions refuse). Also run `select tablename from pg_tables where schemaname = 'public' and not rowsecurity` and expect no rows.
- [ ] 34. Vercel firewall rate limits are in place (6.10), preview deployments point at staging only.
- [ ] 35. A backup restore has been done once on staging and timed (section 9).

## 8. Go-live checklist

Required before **real patient data** is stored. Two lists: **A** is the blueprint's twelve launch-readiness items (technical; each with the evidence in this repository and what you must still check on staging or production), **B** is the owner and legal tasks (design spec sections 11 and 12). Nothing below has been run against a live project yet (section 1).

**A. The twelve launch-readiness items**

| # | Blueprint item | Evidence in the repository | You must still check |
| --- | --- | --- | --- |
| | *Accounts and privacy* | | |
| 1 | Users can sign in, recover access and use the permissions assigned to them | `tests/db/core.test.ts`, `signup.test.ts`, `patients-staff.test.ts`; unit `recovery.test.ts`, `roles.test.ts`, `security-middleware.test.ts`; the authorisation tripwire; e2e global setup (every role signs in, staff with TOTP) and `access.spec.ts` | Section 7 checks 2 to 6 and 9 on staging; each real user signs in; one password reset per role type |
| 2 | Patients cannot retrieve another patient's data, including through direct API requests | `tests/db/isolation.test.ts` (every table), `demo-seed.test.ts` (direct-API twin with the anon/authenticated roles), `portal-payments.test.ts`; e2e `access.spec.ts` (URL guessing and "direct API requests") | Check 33: the direct-API run green against staging; the `pg_tables` query shows RLS on every public table, including any made in Studio |
| 3 | Clinical record access, changes and sensitive exports are audited | `tests/db/notes.test.ts`, `settings-audit.test.ts`, `core.test.ts`; unit `audit-viewer.test.ts`, `audit-page.test.tsx`, `reports-export-route.test.ts`, `notes-privacy.test.ts`; e2e `dashboard.spec.ts` (viewer, export recorded), `notes.spec.ts` | Check 8: audit rows really arrive on staging (sign, view, export, setting change) and only the psychologist reads them |
| | *Booking and clinical work* | | |
| 4 | Patients can book or request appointments and receive the correct status and reminders | `tests/db/booking.test.ts`, `booking-hardening.test.ts`, `booking-terms.test.ts`, `appointment-status.test.ts`, `outbox-worker.test.ts`; unit `slots`, `availability`, `booking-input`, `notify-worker`, `notify-provider`, `templates`; e2e `booking.spec.ts`, `workflow-a` | Checks 27 to 28 and the time-zone check: a real booking gets the status your approval mode implies, and a real reminder email arrives with the right local time |
| 5 | Conflicting bookings are prevented, and rescheduling updates all linked records | `booking.test.ts` (exclusion constraint), `cancellation-policy.test.ts`, `appointment-status.test.ts`; e2e `booking.spec.ts` (two browsers, one slot), `workflow-b` | Check 24; after a reschedule the calendar, portal, reminder (the old one expires) and any fee task agree |
| 6 | A practitioner can create, sign and amend notes with attributable history | `tests/db/notes.test.ts`, `notes-app-calls.test.ts`; unit `notes-content`, `notes-privacy`; e2e `notes.spec.ts`, `workflow-a` | Note editor under the real CSP (check 29); the history shows author and times for every version and addendum |
| | *Payments and reporting* | | |
| 7 | Invoices are linked to the correct patient and billing event | `tests/db/billing.test.ts`, `invoice-per-appointment.test.ts`, `billing-fixes.test.ts`; unit `invoice.test.ts`, `billing-callsites.test.ts`; e2e `billing.spec.ts`, `workflow-a`, `workflow-b` | An invoice made from an appointment names the right patient, session and fee (and VAT per your setting); a late-fee invoice points at the cancelled appointment |
| 8 | Successful, failed, partial and refunded payments are handled correctly | `tests/db/billing-payments.test.ts`, `itn-record.test.ts`, `payfast-unreconciled.test.ts`, `claims-money.test.ts`; unit `itn.test.ts`, `itn-route.test.ts`, `payfast.test.ts`; e2e `workflow-c`, `payments.spec.ts` | Checks 20 to 23 (sandbox). Honest scope: a non-COMPLETE PayFast status records nothing; card payment always pays the whole balance, partial payments are manual or medical-aid; **refunds are manual and out of scope in Phase 1** (refund in the PayFast dashboard, then record a credit note); this item is not complete until a sandbox payment and a manual refund have been walked through |
| 9 | Financial reports reconcile with the underlying transactions and approved adjustments | `tests/db/reports.test.ts`, `void-with-credits.test.ts`, `dashboard-queries.test.ts`; unit `reports-*`; e2e `reports.spec.ts`, `workflow-a` (report row) | For one real month on staging, compare Reports totals with the accountant CSV export, the bank statement and PayFast settlements; credit notes appear as negative lines |
| | *Mobile and operations* | | |
| 10 | Core workflows function on supported iOS, Android and desktop environments | e2e project `chromium-mobile` (375 x 812 emulation, `@mobile` read-only checks) and `chromium-desktop`; responsive layout with a bottom navigation | **Responsive web only; no native apps, and an emulated viewport is not a device.** Required: real iPhone (Safari), real Android phone (Chrome) and a desktop browser pass of sign-in, booking, forms, payments and the staff calendar (check 30) |
| 11 | Errors, interrupted connections and unsaved changes are handled safely | unit `app-shell.test.tsx` (error pages show no internals), `forms-ui.test.tsx`, `forms.test.ts` (autosave, draft conflict); db `form-submit.test.ts` | Checks 14 and 30: drop the network mid-edit in a form and the note editor; no text is lost, the unsaved state is visible, a second tab gets the conflict message |
| 12 | Backups can be restored, incidents can be escalated and system recovery procedures are documented | Section 9 (backups and drill, incident outline, requests, rotation, monitoring); no automated test is possible | A restore drill done and recorded (check 35); the incident call list filled in with real names and numbers |

**B. Owner and legal go-live tasks**

- [ ] O1. Information Officer named (POPIA) and registered with the Information Regulator; name and reference on file.
- [ ] O2. PAIA manual in place and published.
- [ ] O3. POPIA operator agreements signed with Supabase, Vercel, PayFast and the email provider; copies filed.
- [ ] O4. Consent forms, privacy notice and cancellation/financial terms reviewed by the practice and a legal adviser; final wording replaces the DRAFT templates in `lib/forms/templates.ts` (then `UPDATE_SEED=1 npm run test:unit`, and publish as a new template **version**; a used version is never edited).
- [ ] O5. Crisis procedure text final (Settings > Practice; shown in the portal and on the booking confirmation).
- [ ] O6. Retention periods confirmed and entered (Settings > Retention) with any legal hold; nothing is deleted automatically in Phase 1.
- [ ] O7. Data region and cross-border transfer position confirmed and recorded (POPIA section 72), with the region from 6.1.
- [ ] O8. Staff MFA verified for every staff account: each staff user shows a verified authenticator factor in the dashboard, and a sign-in without a code fails.
- [ ] O9. **No demo users or demo data exist.** Run `select email from auth.users where email like '%@demo.test'` (expect no rows), `select name from practices` (not "Demo Practice"), and `select count(*) from patients where phone like '000 000%'` (expect 0). Delete any demo auth user in the dashboard if found, and rotate if there was any doubt.
- [ ] O10. Technical gate: section 7 fully ticked (35 checks); live PayFast credentials, passphrase and IP ranges confirmed; email provider live; session limits set where your plan offers them; `PAYFAST_SANDBOX` not `true`; Vercel preview deployments pointing at staging only.

Do not store real patient data until every item in A and B is done.

## 9. Operations

**Backups and the restore drill.** The primary restore path is Supabase's own managed backups (daily backups, and point-in-time recovery where your plan offers it; check your plan, a free project is not a place for real data). They restore the whole project including the `auth` schema, which the app cannot work without: `profiles`, `guardianships` and `patients.user_id` all reference `auth.users`. A dump of the `public` schema alone (what a plain `supabase db dump` gives) is **not restorable on its own**: it points at users that would not exist. If you also keep your own copies (recommended, encrypted, off-site), include the auth schema: `npx supabase db dump --linked --schema public,auth -f schema.sql` and the same with `--data-only` for the data (check `npx supabase db dump --help` for your CLI version; restoring auth rows into a fresh project is delicate, so treat these as a last resort and test one). Drill, before go-live and then twice a year: (1) restore the latest managed backup into a **new** project (dashboard > Database > Backups), never over production; (2) check row counts of `patients`, `appointments`, `invoices`, `payments`, `clinical_notes` and `audit_log` against production, open a signed note, and run the section 6.3 query; (3) sign in with a test patient and a staff account; whether the staff authenticator factors survive a restore is **not verified**, so record what happens and, if they do not, plan for staff to re-enrol (remove the old factor in the dashboard); (4) record the date, who did it, how long it took and what failed; (5) delete the drill project (it holds real data).

**Incident response (outline; write the real names and phone numbers in).** *Detect:* an alert, an odd audit entry, a patient report, a provider notice. *Contain:* disable the affected user in Supabase Auth and sign out all their sessions, rotate the credentials involved (below), take the affected feature offline if needed, preserve logs (Vercel, Supabase, `audit_log`; do not delete). *Assess:* what personal information, whose, how many people, since when; use the audit viewer and the provider logs. *Notify:* POPIA section 22 requires telling the Information Regulator and the affected data subjects as soon as reasonably possible after the compromise is discovered, when there are reasonable grounds to believe personal information was accessed by an unauthorised person (describe what happened and the steps people can take; follow the Regulator's current process; take the advisor's guidance on wording and timing). Notify the HPCSA or insurer if your policy requires it. *Document:* a dated record of facts, decisions, notifications and fixes; review what to change. Keep a call list: Information Officer, legal advisor, insurer, Supabase/Vercel/PayFast support.

**Data-subject requests (access, correction, deletion) are manual in Phase 1.** Log the request as a task (Tasks > New) and answer within the POPIA/PAIA time limits with your Information Officer. *Access:* export what the person is entitled to: profile, appointments, forms and consents, invoices and payments (staff screens, the CSV exports), and, for clinical notes, the psychologist decides what is released (health records have their own rules; take advice). *Correction:* staff can correct profile and contact data; a signed note is never edited, a correction is an addendum; a submitted form is returned to the patient to correct. *Deletion:* the application has no delete function and the database refuses deletion of appointments, notes, forms, consents, invoices, payments and audit rows (professional and tax record keeping). Patients can be archived. If erasure of something is legally required, it needs a reviewed, one-off SQL procedure agreed with the advisor, recorded in the audit trail; never delete ad hoc. *What is kept and why:* clinical, billing and consent records for the statutory retention period; the audit log as evidence.

**Key and secret rotation.** *Supabase anon/service keys:* Project Settings > API (rotating the JWT secret invalidates all sessions and both keys); update Vercel, redeploy. *`CRON_SECRET`:* change it in Vercel and in any external scheduler together. *PayFast passphrase:* change it in the PayFast dashboard and in Vercel at the same moment (notifications between the two fail and are retried by PayFast); same for merchant key. *Database password:* Settings > Database (the app does not connect directly; only your CLI and backups do). *Email key:* new key at the provider, update Vercel. Any `NEXT_PUBLIC_*` change needs a rebuild. Never commit secrets; `.env*` is git-ignored.

**Monitoring.** Check weekly: Vercel deployment and function error logs; Supabase logs and database health; uptime check on `/login`; the Tasks page (PayFast unreconciled payments, "Notification could not be sent", rejected claims, overdue invoices); the audit viewer for unexpected exports; Settings > Connections (cron, PayFast mode, email provider); GitHub Actions and Dependabot pull requests (`npm audit` gate, `.github/audit-allowlist.json`). Track the backup status.

## 10. Known limitations and deferred items

**Deferred to Phase 2/3 (spec section 2):** automated electronic medical-aid submission and remittance import (claims are tracked by hand), telehealth, secure messaging, treatment plans, document management beyond intake forms, patient refunds (PayFast refunds are done in its dashboard), accounting ledger/balance sheet and expenses/P&L (the accountant export is a transactions CSV), SMS and push (logged stubs; SMS reminders are off), card on file and partial online payments (checkout always bills the whole balance), calendar and accounting integrations, native apps, offline use, AI documentation, group/family sessions, multi-practitioner UI (the `associate` role is schema-only), waiting list, month calendar view, drag-and-drop rescheduling, automatic deletion by retention policy.

**Accepted design limits:** no step-up re-authentication for bank-detail edits (aal2 session, confirmation tick, review panel, audit rows instead); archived patients keep portal login; the patient reschedule keeps the booking's current status; a booking made by staff does not count against a patient's cap of five; manual refs and the over-payment guard rely on staff care for medical-aid versus patient responsibility; a partly-paid claim cannot be re-opened; emails never name conditions so they cannot carry clinical detail; Next.js 15 with advisories that only a Next 16 upgrade fixes (`docs/reference.md`, "Dependencies"); PNG app icons are missing (SVG only); `style-src` keeps `'unsafe-inline'`; CSP and cache headers on Vercel are unverified until check 29.

## 11. Where things are

```
app/                 Next.js routes: (public)/book, (auth)/login|register|mfa|recover, app/ (staff), portal/ (patients), api/payfast/itn, api/cron/reminders
components/          ui/ (Button, Field, StatusChip, Notice, SlotPicker...), shell/, calendar/, dashboard/, reports/, settings/, tasks/
lib/                 domain logic by area: auth, booking, appointments, billing, payments (payfast, itn), claims, notes, forms, notify, reports, settings, security (csp, headers), supabase clients
middleware.ts        session refresh, anonymous redirect, per-request CSP nonce
next.config.ts       static security headers, no-store rules
supabase/migrations  0001..0029, applied in order; supabase/seed.sql (generated DRAFT form templates, the only file db reset loads) and supabase/seed-demo.sql (fictional demo accounts, manual and opt-in only, never production); supabase/test_bootstrap.sql (test-only auth stub); supabase/config.toml
tests/unit           Vitest (no database)      tests/db  Vitest on embedded PostgreSQL      tests/e2e  Playwright (helpers/, global-setup.ts)
scripts/             audit-check.mjs (CI gate), e2e.mjs (npm run test:e2e wrapper)
docs/                decisions.md (plain language), reference.md (subsystems), superpowers/specs + plans
.github/             workflows/ci.yml, dependabot.yml, audit-allowlist.json
vercel.json          cron schedule
```

**Scripts:** `dev`, `build`, `start`, `lint`, `typecheck`, `test:unit`, `test:db`, `test:e2e`.

**Conventions.** A pushed migration is never edited: add the next-numbered file (tests pick it up with no wiring). Every new public table enables RLS (a test enforces it) and every `security definer` function revokes execute from `public` and `anon`. Money in integer cents, formatted by `lib/money.ts`. Every new page, action or route calls `requireRole`/`requireUser` first and awaits it. Form templates are written in `lib/forms/templates.ts`; after editing run `UPDATE_SEED=1 npm run test:unit` to regenerate the block between the markers in `seed.sql` (a test fails if they drift); change a form by inserting a new **version**. Emailed links use `appUrl()`. Anything new that reads an environment variable must be added to `.env.example`. Commit messages end with the co-author line used in this repository; work happens on `phase-1` and is pushed to `origin`. The internal rulings behind many of these rules are summarised in `docs/decisions.md`.

**Dependencies.** CI runs `node scripts/audit-check.mjs` (fails only on a new high/critical advisory not in `.github/audit-allowlist.json`); Dependabot opens weekly PRs. Known open advisories and why they are accepted are in `docs/reference.md`.
