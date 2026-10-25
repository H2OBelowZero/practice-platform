-- TEST ONLY: stubs the parts of Supabase that migrations depend on, so migrations run on plain Postgres.
-- Real Supabase already provides all of this. Applied by tests/db/global-setup.ts before the migrations.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text,
  instance_id uuid,
  aud text,
  role text,
  raw_user_meta_data jsonb,
  email_confirmed_at timestamptz,
  -- the columns the demo seed (supabase/seed.sql) writes, as in the real auth.users
  encrypted_password text,
  raw_app_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  confirmation_token text,
  recovery_token text,
  email_change_token_new text,
  email_change text,
  email_change_token_current text,
  phone_change text,
  phone_change_token text,
  reauthentication_token text
);
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  email text generated always as (lower(identity_data ->> 'email')) stored,
  unique (provider_id, provider)
);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as
$$ select nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role' $$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant select on auth.users to service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

-- Supabase grants everything in public to these roles by default; RLS and explicit revokes do the restricting.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
