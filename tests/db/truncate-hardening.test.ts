import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, asService, mkUser } from "./helpers";

// R20. Dynamic on purpose: the table list comes from pg_class, so a table added by a LATER migration is checked without editing this file.
const ROLES = ["anon", "authenticated", "service_role"];

async function offenders(c: Client) {
  const maintain = Number((await c.query("show server_version_num")).rows[0].server_version_num) >= 170000;
  const privs = ["TRUNCATE", "TRIGGER", "REFERENCES", ...(maintain ? ["MAINTAIN"] : [])];
  const { rows } = await c.query(
    `select c.relname as tbl, r.rolname as role, p.priv
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join unnest($1::text[]) as r(rolname) cross join unnest($2::text[]) as p(priv)
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm') and has_table_privilege(r.rolname, c.oid, p.priv)
      order by 1, 2, 3`, [ROLES, privs]);
  return rows.map((x) => `${x.role} has ${x.priv} on ${x.tbl}`);
}

it("no ordinary public table grants TRUNCATE, TRIGGER or REFERENCES (or MAINTAIN on PG17+) to anon, authenticated or service_role", () => withClient(async (c) => {
  const n = Number((await c.query("select count(*) from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind in ('r','p')")).rows[0].count);
  expect(n).toBeGreaterThan(20); // the loop is not vacuous
  expect(await offenders(c)).toEqual([]);
}));

it("a table created after the migration also starts without them (default privileges)", () => withClient(async (c) => {
  await c.query("create table zz_future_table (id int primary key)");
  expect(await offenders(c)).toEqual([]);
  // ...but the everyday privileges the RLS policies rely on are still granted by default
  for (const r of ROLES) for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
    expect((await c.query("select has_table_privilege($1, 'zz_future_table', $2) as ok", [r, p])).rows[0].ok, `${r} ${p}`).toBe(true);
}));

it("select, insert, update and delete are still granted on existing tables (DELETE on patients, tasks and guardianships is revoked by 0031)", () => withClient(async (c) => {
  for (const r of ["authenticated", "service_role"]) {
    for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
      expect((await c.query("select has_table_privilege($1, 'appointments', $2) as ok", [r, p])).rows[0].ok, `${r} ${p}`).toBe(true);
    for (const p of ["SELECT", "INSERT", "UPDATE"])
      expect((await c.query("select has_table_privilege($1, 'patients', $2) as ok", [r, p])).rows[0].ok, `${r} ${p}`).toBe(true);
    for (const t of ["patients", "tasks", "guardianships"])
      expect((await c.query("select has_table_privilege($1, $2, 'DELETE') as ok", [r, t])).rows[0].ok, `${r} DELETE ${t}`).toBe(false);
  }
}));

it("TRUNCATE as authenticated, service_role and anon fails with permission denied, and the rows survive", () => withClient(async (c) => {
  const u = await mkUser(c, "psychologist");
  await c.query("insert into patients(user_id, first_name, last_name) values ($1, 'T', 'Runcate')", [u]);
  const before = (await c.query("select count(*) from patients")).rows[0].count;
  await asUser(c, u, async () => {
    await expect(c.query("truncate patients")).rejects.toThrow(/permission denied/);
    await expect(c.query("truncate table appointments, invoices cascade")).rejects.toThrow(/permission denied/);
  });
  await asService(c, async () => { await expect(c.query("truncate patients")).rejects.toThrow(/permission denied/); });
  await c.query("set local role anon");
  await expect(c.query("truncate patients")).rejects.toThrow(/permission denied/);
  await c.query("reset role");
  expect((await c.query("select count(*) from patients")).rows[0].count).toBe(before);
}));

it("views are covered too: claim_summary and invoice_balances lose the extra privileges but stay readable by the roles that could read them", () => withClient(async (c) => {
  const kinds = (await c.query("select relname, relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname = any('{claim_summary,invoice_balances}')")).rows;
  expect(kinds.map((r) => r.relkind)).toEqual(["v", "v"]); // the dynamic check below really includes views
  const can = async (role: string, rel: string) => (await c.query("select has_table_privilege($1, $2, 'SELECT') as ok", [role, rel])).rows[0].ok;
  expect(await can("authenticated", "claim_summary")).toBe(true);
  expect(await can("anon", "claim_summary")).toBe(false);
  expect(await can("authenticated", "invoice_balances")).toBe(true);
  expect(await can("service_role", "invoice_balances")).toBe(true);
  expect(await can("anon", "invoice_balances")).toBe(false);
  expect(await offenders(c)).toEqual([]);
}));

it("a view created later also starts without TRUNCATE/TRIGGER/REFERENCES (default privileges), SELECT stays", () => withClient(async (c) => {
  await c.query("create view zz_future_view as select 1 as x");
  expect(await offenders(c)).toEqual([]);
  expect((await c.query("select has_table_privilege('authenticated', 'zz_future_view', 'SELECT') as ok")).rows[0].ok).toBe(true);
}));

it("the verification query in the README is valid and returns no rows (so the owner can trust it after deploy)", () => withClient(async (c) => {
  const { readFileSync } = await import("node:fs");
  const readme = readFileSync("README.md", "utf8");
  const sql = /```sql\n(\s*-- tables, views[\s\S]*?)```/.exec(readme)?.[1];
  expect(sql, "README verification query not found").toBeTruthy();
  expect((await c.query(sql!)).rows).toEqual([]);
  await c.query("create table zz_bad (id int)");
  await c.query("grant truncate on zz_bad to authenticated");
  expect((await c.query(sql!)).rows.map((r) => `${r.relname}:${r.rolname}:${r.priv}`)).toEqual(["zz_bad:authenticated:TRUNCATE"]);
}));
