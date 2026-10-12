# Practice Platform

Next.js 15 + Supabase app for a private psychologist practice.

## Setup

```
npm ci
cp .env.example .env.local   # fill in values
npm run dev
```

## Scripts

- `npm run typecheck` / `npm run lint`
- `npm run test:unit` - Vitest unit tests (`tests/unit`)
- `npm run test:db` - DB tests (`tests/db`) against a throwaway local Postgres (no Docker, no Supabase CLI)
- `npm run test:e2e` - Playwright; needs a running Supabase (staging project), not run in CI

## Seed data and form templates

`supabase/seed.sql` (local and staging only) holds version 1 of the intake forms and consents. The wording is FICTIONAL / DRAFT and must be reviewed by the practice and a legal advisor before live use.
The templates are written in `lib/forms/templates.ts`; after editing them run `UPDATE_SEED=1 npm run test:unit` to regenerate the block between the markers in `seed.sql` (a unit test fails if the two drift apart).

## Testing caveat

DB tests stub Supabase's `auth` schema (roles, `auth.users`, `auth.uid()`), so Supabase Auth behaviour
(MFA, the signup trigger on the real auth schema) is only verified after deploy to a real Supabase project.

## Auth

Sign-in is Supabase Auth (email + password). Config for local/self-hosted CLI use is in `supabase/config.toml`
(signup and email confirmation on, TOTP MFA enrol+verify on, `jwt_expiry = 3600`, minimum password length 12).
On a hosted project set the same in the dashboard (Authentication), add `APP_URL/auth/callback` to the redirect
allow-list, and set `APP_URL` to the site's public origin (used for password-reset links).

- **Patients** sign up themselves; the `handle_new_user` trigger (`0006_signup.sql`) always creates a `patient`
  profile and ignores any role in the signup metadata.
- **Staff accounts** are created by the owner in the Supabase dashboard (Authentication > Users > Add user, with a
  password of at least 12 characters) and then promoted in the SQL editor. This is the only way to get a staff role:

  ```sql
  update profiles set role = 'psychologist' where user_id = (select id from auth.users where email = 'owner@example.com');
  -- other staff roles: 'admin', 'bookkeeper', 'associate'
  ```
- **MFA**: every staff role must pass TOTP (aal2). On first sign-in staff are sent to `/mfa`, scan the QR code with an
  authenticator app and enter one code; afterwards they enter a code at each sign-in. `requireRole` / `requireUser`
  (`lib/auth/session.ts`) enforce this on the server for every protected page; middleware only refreshes the session
  and sends anonymous visitors from `/app` and `/portal` to `/login`.
- **Audit**: server code calls `audit()` (`lib/audit.ts`), which resolves the verified user and role and writes through
  the service-role-only `audit_append()`. Signed-in users cannot write audit rows (`audit_write` is DB-internal only).
- **Password reset**: `/recover` emails a link to `/auth/callback`, which lands on `/recover/reset`. That page and its
  action only accept a session whose verified `amr` shows a password-recovery sign-in within the last 15 minutes
  (`lib/auth/recovery.ts`); staff must also pass TOTP first. `secure_password_change = true` is set in
  `supabase/config.toml`; **the hosted project needs the same setting** (Authentication > Providers > Email > "Secure
  password change"). `APP_URL` must be set in production (the app refuses to build emailed links without it).
- **Sign-out** (`signOut`) uses Supabase's default global scope: it ends the session on all of the user's devices. The
  fail-closed path at sign-in (audit write failed) only ends the session on the current device and clears the cookies.

### Auth: operating notes and go-live checklist

- **Staff handover**: the TOTP authenticator must be enrolled at handover. The person who creates a staff account
  should be present while the new user signs in and scans the QR code at `/mfa` (or send an invite and have the
  user do it immediately). Until a staff account has a verified factor, anyone holding its password can enrol their own
  authenticator on first sign-in.
- **Email confirmation is a security control (MUST be on)**: in the hosted Supabase project enable Authentication >
  Providers > Email > "Confirm email", and turn on "Secure email change". `ensure_patient_record()` (0008) only attaches a
  staff-created patient record to a self-registered account when the account's email is confirmed, exactly one unlinked
  row has that address, and staff have invited that person to the portal (`patients.portal_invited_at`, set by the
  "Invite to portal" action added in Task 11) and the row is not a minor or archived. With confirmation off, anyone could
  register someone else's address and read their record. Every other registration gets a new prospect row, and a
  "Possible duplicate patient: review and merge" task is raised when an email-matching row existed but could not be linked.
- **Session limits**: at go-live set the Supabase session time-box and inactivity timeout (Authentication > Sessions;
  Pro plan feature) so idle staff sessions expire.
- **Authorisation is not middleware**: `middleware.ts` only refreshes the session and bounces anonymous visitors. Every
  `/app` and `/portal` page, server action and route handler must itself call `requireRole` / `requireUser`
  (`lib/auth/session.ts`), which also sends staff without aal2 to `/mfa` and back to the page they wanted.

Caveat (R14): the DB tests stub the `auth` schema, and there is no Supabase project in CI, so the Supabase Auth flows
(sign-in, MFA enrolment and verification, email confirmation and recovery links, the signup trigger on the real
`auth.users`) are only verified after deploying to a real Supabase project (see the e2e specs in Task 18).

## Payments: PayFast

Card payments go through PayFast's hosted checkout. Money is recorded **only** by the server-to-server notification (ITN) at
`POST /api/payfast/itn`; the browser `return_url` page just shows the stored status. Code: `lib/payments/payfast.ts`
(signing, checkout form, IP ranges, server-side validate), `lib/payments/itn.ts` (the ordered checks), `app/api/payfast/itn/route.ts`.

Environment variables (`.env.example`):

| Variable | Notes |
| --- | --- |
| `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY` | From the PayFast dashboard (Settings > Integration). Building a checkout throws if either is missing; the ITN returns 500 if the merchant id is missing. |
| `PAYFAST_PASSPHRASE` | **REQUIRED in production** and must equal the passphrase in the PayFast dashboard (Settings > Integration > Security passphrase); a mismatch makes every signature fail. Without it the signature is an unkeyed MD5 anyone can compute, so outside the sandbox the ITN answers 500 `misconfigured` and the checkout refuses to build. Only `PAYFAST_SANDBOX=true` may run without one. |
| `PAYFAST_SANDBOX` | Exactly `true` selects `sandbox.payfast.co.za`; anything else (including unset) is the **live** host `www.payfast.co.za`. |
| `APP_URL` | Public origin; the notify URL is `${APP_URL}/api/payfast/itn`. |
| `SUPABASE_SERVICE_ROLE_KEY` | The ITN runs as the service role (`record_payment` accepts the `payfast` method only from a `service_role` JWT). |

What the ITN does, in order (R36): body <= 10 KB -> MD5 signature (constant-time, PHP `urlencode` rules, every posted field in
received order) -> source IP in a PayFast range -> `merchant_id` -> `m_payment_id` is an invoice UUID that exists -> replay
(`PF-<pf_payment_id>` already recorded for this invoice and amount: answer 200 without calling PayFast) -> `payment_status`
COMPLETE only -> `amount_gross` equals the invoice's outstanding balance (to the cent, parsed from the string) -> PayFast
server-side `/eng/query/validate` -> `record_payment`. Rejections of a request whose signature verified are written to the audit log
(`payfast.itn.rejected`, reason code only, never the body); rejections before that point (oversize, unparseable, bad signature) are
anonymous, write no audit row (log flooding) and only log a fixed reason code to the server console. HTTP 200 means "stop retrying" (recorded, duplicate, ignored status, or invoice already closed),
400 means refused, 500 means PayFast should retry (PayFast unreachable, database error). The checkout always bills the whole
outstanding balance; part payments come from manual and medical-aid recording.

### The patient / guardian Payments pages (`/portal/payments`)

Patients and guardians (a guardian needs `permissions.pay`) see their issued invoices, what is outstanding, payments and receipts, all read with
their own session so row-level security decides what arrives. "Pay now" is offered per invoice by `payNowAllowed()` (`lib/billing/pay-now.ts`,
R40): self-pay invoices always; medical aid / split invoices only once the medical aid side is settled (scheme remittances plus credit notes
marked "medical aid shortfall" cover the scheme portion) and what is left is the patient's own part. The server action `startPayfastCheckout`
re-reads everything through RLS, recomputes that verdict and the amount (the whole outstanding balance, never a number from the browser; the
amount the page showed is only used to refuse a stale click), builds the signed form with the signed-in user's own name and email, and the page
POSTs it to PayFast. The return URL page (`?paid=<invoice id>`) shows stored status only ("We're confirming your payment" or "Paid, thank you");
only the signed ITN records money. Bank details for EFT come from `practices.payment_instructions` (plain text; the psychologist edits it in the
settings task; default "Please contact the practice for EFT details."). With PayFast not configured (no merchant id/key, no passphrase outside
the sandbox, no `APP_URL` in production) the pages show "Online payment is not available right now" instead of a button.

### Payments that no longer fit the invoice (reconciliation)

A genuine payment can arrive for an invoice that no longer takes it: paid twice, voided, a credit note or a medical-aid remittance
reduced the balance between checkout and notification. The money is real, so the ITN does not refuse it. After PayFast's own validate
says `VALID` it answers 200, writes an audit row `payfast.itn.unreconciled` (reason `amount_mismatch` / `invoice_not_payable` /
`overpay`, invoice id, `pf_payment_id`, amount and outstanding in cents) and raises ONE staff task, **"PayFast payment needs
reconciliation"** (high priority, linked to the patient, source `payfast_unreconciled:<pf_payment_id>`; visible to psychologist and
admin, no clinical data; the invoice id, reason and amounts are in the task's `meta`). A PayFast retry of the same notification
is a no-op. If validate is not `VALID` the ITN answers 400 and no task is created; if PayFast cannot be reached it answers 500 and
PayFast retries.

To reconcile: open the task, find the payment in the PayFast dashboard by `pf_payment_id` (or by the invoice id, which is the
`m_payment_id`), then either **refund the payment from the PayFast dashboard** or, when the money should be kept, record an
adjustment against the right invoice (manual payment or credit note), and mark the task done. **PayFast refunds are manual in
Phase 1**: nothing in the app calls PayFast to refund.

Go-live checklist:

- **`notify_url` must be publicly reachable over HTTPS** (not localhost; use a tunnel such as ngrok for local sandbox tests) and
  must not redirect, sit behind authentication or be blocked by a firewall.
- **Confirm the source IP ranges** against PayFast's current documentation: `PAYFAST_IP_RANGES` in `lib/payments/payfast.ts`
  (197.97.145.144/28, 41.74.179.192/27, 102.216.36.0/28, 102.216.36.128/28, 144.126.193.139/32). They are enforced for sandbox
  ITNs too. **Put no other proxy (e.g. Cloudflare) in front of Vercel**: the client address would become the proxy's and genuine
  PayFast notifications would be rejected as `bad_ip`. The route reads the client address from `x-vercel-forwarded-for` / the first `x-forwarded-for` entry, which Vercel
  overwrites; on any other host those headers are caller-controlled, so the IP check is then only advisory (signature, merchant id
  and PayFast's own validate still apply).
- Confirm the checkout field order and the signature rules in PayFast's documentation (`CHECKOUT_FIELD_ORDER`). The ITN signature
  covers every posted field including empty ones; the checkout signature skips empty values.
- Set the PayFast dashboard's ITN to enabled and the passphrase to match; switch `PAYFAST_SANDBOX` off and use live credentials.

Testing in the sandbox: create a sandbox merchant at sandbox.payfast.co.za (or use the public test merchant from PayFast's
docs), set `PAYFAST_SANDBOX=true` with those credentials, expose the dev server with an HTTPS tunnel and set `APP_URL` to it,
issue an invoice, pay it from the portal with a sandbox buyer account, and check `payments` (method `payfast`, `gateway_ref`
`PF-<id>`) and the audit log. Resend the ITN from the sandbox dashboard to see the replay answered with 200 and no second row.
Automated tests cover the logic with a simulated PayFast (`tests/unit/itn.test.ts`, `tests/db/itn-record.test.ts`); no real
PayFast call is made in CI.

## Notifications: outbox, reminders and the cron job

Anything the app wants to tell a person is a row in `notifications_outbox` (written with the service client by the booking, portal-invite, forms
and billing code). A scheduled worker sends the rows; nothing is sent inside a user's request.

- **Route**: `GET` (or `POST`) `/api/cron/reminders` (`app/api/cron/reminders/route.ts`, worker in `lib/notify/worker.ts`). One run: queue the 24 hour
  reminders (`enqueue_reminders()`), raise a staff task for each overdue invoice (`enqueue_overdue_tasks()`), then claim due rows in batches of 25
  (at most 4 batches, 20 second budget), render, send and record each one (`claim_outbox()` / `finish_outbox()`, migrations 0022 and 0023). A row is tried at
  most 3 times (10 and 20 minute backoff) and then marked `failed` (a short code in `last_error`, never a provider reply) and ONE staff task
  "Notification could not be sent" is raised (the template and channel are in the task's meta, no recipient). A run that runs out of time hands the
  remaining rows back without using up an attempt (`release_outbox`). A crashed run's
  rows are claimed again after 10 minutes, and two overlapping runs never take the same row (`FOR UPDATE SKIP LOCKED`).
- **Response and logs**: counts and short codes only (no recipients, no content). One `cron.reminders.run` audit row per run in which something happened
  (a count above zero or an error; quiet 15 minute runs leave none; counts, no personal data). `emailProvider` in the response is `resend`, `console`
  (development only, nothing is delivered) or `none`; with `none` the response says `skipped: "provider_not_configured"`.
- **No provider, nothing sent**: in production without `EMAIL_API_KEY` and `EMAIL_FROM` the worker still queues reminders and tasks but does NOT claim or send
  email rows (they stay pending), and logs one fixed line. Rows that become stale while waiting are expired by `claim_outbox` (`failed`, `last_error` =
  `expired`, no task) instead of being sent late: reminders for an appointment that is no longer confirmed or has started, reminders more than 2 hours past
  their send time, and booking/cancel/reschedule emails older than 48 hours. Switching a provider on days later therefore does not email old reminders.
- **Reminders**: confirmed appointments starting 23 to 25 hours from now, for patients whose reminder choice (`patients.comms_prefs`, set on
  `/portal/settings`) is on and who have the contact detail (archived patients get none). One per appointment and channel (`dedupe_key`), so the 15 minute schedule never repeats one.
  The message holds the date and time (South African time) and a link; the worker adds `APP_URL` in front of the stored path.
- **Overdue invoices**: one staff task per invoice, ever ("Overdue invoice: follow up", no names), linked to the invoice on the tasks page.
- **Message privacy** (`lib/notify/templates.ts`, `tests/unit/templates.test.ts`): subjects are fixed text, bodies hold only a date, a time and one link;
  no names, amounts, invoice numbers, form names or clinical words; every email ends with the same footer (the generic emergency line "call 10177 or go to the nearest emergency room", no support-group names, so an email never hints at mental-health context). A link is sent only if it is a path on this
  app or already on `APP_URL`'s origin; any other link makes the row fail (`bad_link`) instead of being sent.

Environment variables:

| Variable | Notes |
| --- | --- |
| `CRON_SECRET` | **Required.** A long random value (for example `openssl rand -hex 32`). The route answers 500 `misconfigured` when it is not set and 401 for anything but `Authorization: Bearer <CRON_SECRET>` (compared in constant time). When this variable is set on Vercel, Vercel sends that header on every scheduled call by itself. |
| `EMAIL_API_KEY`, `EMAIL_FROM` | Set both to send real email. In production, without both, nothing is sent and email rows stay pending (see above); a key without a sender counts as not configured. Outside production, with neither set, a console provider logs only the outbox id, template and channel (never the address or text) and the rows are marked sent. `EMAIL_FROM` is the verified sender, for example `Bookings <bookings@yourdomain.co.za>`. |
| `SMS_ACTIVE` | `true` only once a real SMS provider is wired in (Phase 1 has none). While it is not `true`, no SMS reminder rows are queued and any SMS rows are never claimed. |
| `APP_URL` | Origin put in front of emailed links. Required in production. |

**The email provider is a placeholder choice.** `lib/notify/provider.ts` ships a Resend adapter (`https://api.resend.com/emails`, 8 second timeout) only so
that the worker is complete; **the practice owner must confirm the provider.** Another service needs only another class with the same `send()` method. SMS and
push use a console provider in Phase 1: SMS reminders are neither queued nor sent while `SMS_ACTIVE` is not `true`, and the settings page says "SMS
reminders are not active yet". A patient's email address and phone number can only be changed by staff (database guard), so reminders cannot be redirected. **POPIA**: whichever email (or SMS) service is used processes personal information (addresses, appointment times) for the
practice, so a written operator agreement under section 21 of POPIA must be signed with it, and where its servers are (cross-border transfer, section 72)
recorded, before live use. Keep message content as neutral as it is now.

**Schedule**: `vercel.json` runs the route every 15 minutes (`*/15 * * * *`). **Vercel's Hobby plan only allows cron jobs that run once a day**
(and a deployment with a more frequent schedule is refused), so 15 minute reminders need the **Pro** plan. On Hobby, either change the schedule to daily (reminders
then go out once a day, and an appointment can fall between two runs), or leave the cron entry out and call the endpoint from an external scheduler:

```
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://YOUR-APP/api/cron/reminders
```

Not verified without a live setup: a real provider call, the Vercel schedule itself, and the SQL against a real Supabase project (the DB tests run on plain Postgres).

## Staff dashboard, tasks and audit viewer

- `/app` (psychologist, admin; a bookkeeper is sent to Billing, anyone else gets a 404) reads every number through the signed-in user's own RLS client, in
  parallel, with counts and SQL aggregates (`billing_open_by_due_date`, `dashboard_payments_by_method`, migration 0024). A failed query shows a quiet note in
  its own tile or section. The admin gets the same operational tiles and no notes tile.
- `/app/tasks` (psychologist, admin): filters by status, priority, due date and kind (`lib/tasks/groups.ts` classifies the task sources), create / edit /
  complete / reopen (audited `task.create`, `task.update`, `task.complete`, `task.reopen`: ids and field names only). Clinical-risk tasks exist only for the psychologist (RLS).
- `/app/audit` (psychologist only): filters, 50 per page, whitelisted detail (`lib/audit-viewer/detail.ts`), CSV at `/app/audit/export` (max 5000 rows, formulas
  neutralised by `lib/reports/csv.ts`). Viewing writes `audit.view` and exporting writes `export.audit`; both fail closed. A 5 000 row export is read in pages of
  1 000 because the API caps a response.
- Reports and Settings are hidden in the navigation until Task 16b adds their pages (`ready: false` in `lib/nav.ts`).
