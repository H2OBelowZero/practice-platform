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
