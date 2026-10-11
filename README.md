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
- **Password reset**: `/recover` emails a link to `/auth/callback`, which lands on `/recover/reset`.

Caveat (R14): the DB tests stub the `auth` schema, and there is no Supabase project in CI, so the Supabase Auth flows
(sign-in, MFA enrolment and verification, email confirmation and recovery links, the signup trigger on the real
`auth.users`) are only verified after deploying to a real Supabase project (see the e2e specs in Task 18).
