// DB test harness. Tests run against a throwaway Postgres started by tests/db/global-setup.ts
// (embedded-postgres, no Docker). It applies supabase/test_bootstrap.sql (Supabase stubs) and then every
// supabase/migrations/*.sql in filename order, and exposes the URL as DATABASE_URL_TEST.
// NOTE: every test runs in one rolled-back transaction, so DEFERRED constraints/triggers never fire and
// now()/current_date are frozen; use `set constraints all immediate` where needed.
// New migration? Just add the file; no other wiring needed. Every test runs in a transaction that is rolled back.
import { Client } from "pg";

/** Superuser/owner connection inside a transaction that is always rolled back. */
export async function withClient<T>(fn: (c: Client) => Promise<T>) {
  const c = new Client({ connectionString: process.env.DATABASE_URL_TEST });
  await c.connect();
  const raw = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
  try {
    await raw("begin");
    // Run each statement under a savepoint so an expected failure does not abort the whole transaction.
    (c as unknown as { query: typeof raw }).query = async (...a) => {
      await raw("savepoint t");
      try { const r = await raw(...a); await raw("release t"); return r; }
      catch (e) { await raw("rollback to t"); throw e; }
    };
    return await fn(c);
  } finally { await raw("rollback"); await c.end(); }
}
/** run queries as an authenticated Supabase user inside a rolled-back transaction */
export async function asUser<T>(c: Client, sub: string, fn: () => Promise<T>) {
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub, role: "authenticated" })]);
  try { return await fn(); } finally {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)"); // no stale auth.uid() for later superuser queries
  }
}
export async function asService<T>(c: Client, fn: () => Promise<T>) {
  await c.query("set local role service_role");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
  try { return await fn(); } finally { await c.query("reset role"); }
}
export async function mkUser(c: Client, role: string, name = role) {
  const { rows } = await c.query(
    "insert into auth.users(id,email,instance_id,aud,role) values (gen_random_uuid(), $1||'@t.test', '00000000-0000-0000-0000-000000000000','authenticated','authenticated') returning id",
    [name + Math.random().toString(36).slice(2)]);
  await c.query("insert into profiles(user_id,role,display_name) values ($1,$2,$3)", [rows[0].id, role, name]);
  return rows[0].id as string;
}
