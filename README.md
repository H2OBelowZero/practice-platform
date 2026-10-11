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
