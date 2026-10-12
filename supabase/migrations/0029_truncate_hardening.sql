-- supabase/migrations/0029_truncate_hardening.sql
-- Task 17a (R20). Supabase grants ALL on every public table to anon, authenticated and service_role and relies on RLS plus explicit revokes.
-- TRUNCATE (and TRIGGER, REFERENCES, MAINTAIN) are not subject to RLS. They are not reachable through PostgREST, but any path that runs raw SQL
-- as one of these roles (a future RPC, a leaked service key used over a direct connection) could wipe a table without a trace. The app never needs them:
--   TRUNCATE   - nothing in the app deletes by truncating
--   TRIGGER    - triggers are created by the migration owner, not by these roles
--   REFERENCES - foreign keys are created by the migration owner; FK checks at run time run as the table owner
--   MAINTAIN   - (PostgreSQL 17+) VACUUM/ANALYZE/LOCK TABLE: LOCK ... ACCESS EXCLUSIVE would block the table for everyone
-- select/insert/update/delete are NOT touched: the RLS policies and column-level revokes in earlier migrations build on them.

do $$
declare
  t record;
  extra text := case when current_setting('server_version_num')::int >= 170000 then ', maintain' else '' end;
begin
  -- every ordinary (r) and partitioned (p) table that exists today; audit_log's own revokes (0001) are a subset of this
  for t in
    select c.oid::regclass as tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('revoke truncate, trigger, references%s on %s from anon, authenticated, service_role', extra, t.tbl);
  end loop;

  -- tables created later by this role (the migration owner) start without them. Schema-level entries only remove what this
  -- schema's own default ACL granted, which on Supabase is where the grants to these three roles come from. tests/db/truncate-hardening.test.ts
  -- creates a table at run time and checks it, and README lists the same query to run once on the hosted project.
  execute format('alter default privileges in schema public revoke truncate, trigger, references%s on tables from anon, authenticated, service_role', extra);
end $$;
