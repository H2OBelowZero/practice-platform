import type { Client } from "pg";
import { it, expect } from "vitest";
import { withClient, asUser, asService } from "./helpers";
import { seed, mkInvoice, pay } from "./billing-helpers";

// 0024: dashboard_payments_by_method (aggregate only, staff money roles only) and the indexes the audit viewer and tasks page rely on.
const day = async (c: Client, offset: number) => (await c.query("select (sa_today() + $1::int)::text d", [offset])).rows[0].d as string;
const by = async (c: Client, u: string, from?: string, to?: string) => {
  const f = from ?? (await day(c, -10)), t = to ?? (await day(c, 0));
  return asUser(c, u, async () => (await c.query("select method, n, total_cents from dashboard_payments_by_method($1, $2)", [f, t])).rows);
};

it("sums succeeded payments per method over the date range, in integer cents", () => withClient(async (c) => {
  const { psy, adm, bk, p1, p2 } = await seed(c);
  const i1 = await mkInvoice(c, p1, { total: 100000 }), i2 = await mkInvoice(c, p2, { total: 50000 });
  await pay(c, psy, i1, "eft", 30000, "R1", await day(c, -5));
  await pay(c, psy, i1, "cash", 20000, null, await day(c, -3));
  await pay(c, psy, i2, "eft", 5000, "R2", await day(c, 0));
  await pay(c, psy, i2, "eft", 1000, "R3", await day(c, -40)); // before the range
  const want = [{ method: "cash", n: "1", total_cents: "20000" }, { method: "eft", n: "2", total_cents: "35000" }];
  for (const u of [psy, adm, bk]) expect(await by(c, u)).toEqual(want); // aggregates only: the bookkeeper gets the same three columns
  expect(await by(c, psy, await day(c, -60), await day(c, -30))).toEqual([{ method: "eft", n: "1", total_cents: "1000" }]);
  expect(await by(c, psy, await day(c, -2), await day(c, -1))).toEqual([]);
}));

it("refuses patients, guardians and associates, and an unreasonable range", () => withClient(async (c) => {
  const { psy, assoc, u1, g, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 100000 });
  await pay(c, psy, i, "cash", 100, null, await day(c, -1));
  for (const u of [u1, g, assoc]) await expect(by(c, u)).rejects.toThrow(/forbidden/);
  await expect(by(c, psy, await day(c, 0), await day(c, -1))).rejects.toThrow(/invalid_range/);
  await expect(by(c, psy, await day(c, -500), await day(c, 0))).rejects.toThrow(/invalid_range/);
}));

it("is not executable by anon, and a service-role call has no staff role so it is refused too", () => withClient(async (c) => {
  await c.query("set local role anon");
  await expect(c.query("select * from dashboard_payments_by_method(current_date, current_date)")).rejects.toThrow(/permission denied/);
  await c.query("reset role");
  await expect(asService(c, () => c.query("select * from dashboard_payments_by_method(current_date, current_date)"))).rejects.toThrow(/forbidden/);
}));

it("is SECURITY INVOKER and granted to authenticated and service_role only", () => withClient(async (c) => {
  expect((await c.query("select prosecdef from pg_proc where proname = 'dashboard_payments_by_method'")).rows).toEqual([{ prosecdef: false }]);
  const g = (await c.query(`select has_function_privilege('anon', 'dashboard_payments_by_method(date,date)', 'execute') a,
    has_function_privilege('authenticated', 'dashboard_payments_by_method(date,date)', 'execute') b,
    has_function_privilege('service_role', 'dashboard_payments_by_method(date,date)', 'execute') s`)).rows[0];
  expect(g).toEqual({ a: false, b: true, s: true });
}));

it("creates the audit_log and tasks indexes", () => withClient(async (c) => {
  const names = (await c.query("select indexname from pg_indexes where schemaname = 'public' and tablename in ('audit_log','tasks')")).rows.map((r) => r.indexname);
  for (const n of ["audit_log_at_idx", "audit_log_entity_idx", "audit_log_actor_at_idx", "tasks_status_due_idx", "tasks_source_prefix_idx"]) expect(names).toContain(n);
}));
