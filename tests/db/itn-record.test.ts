import type { Client } from "pg";
import { it, expect } from "vitest";
import { withClient, asService, asUser } from "./helpers";
import { seed, mkInvoice, status, paid } from "./billing-helpers";

// The exact calls app/api/payfast/itn/route.ts makes (via lib/payments/itn-deps.ts), as the service role, with the same named
// parameters supabase-js sends to PostgREST. See also tests/unit/itn-deps.test.ts, which pins the parameter names.
const itnRecord = (c: Client, invoice: string, amount: number, ref: string) =>
  asService(c, () => c.query("select record_payment(p_invoice => $1, p_method => 'payfast', p_amount => $2, p_ref => $3, p_by => null) id", [invoice, amount, ref]));
/** what loadOutstanding reads: invoices.total_cents, credit_notes sum, invoice_paid_cents rpc */
const outstanding = (c: Client, invoice: string) => asService(c, async () => {
  const total = (await c.query("select total_cents from invoices where id=$1", [invoice])).rows[0].total_cents as number;
  const credit = Number((await c.query("select coalesce(sum(amount_cents),0) s from credit_notes where invoice_id=$1", [invoice])).rows[0].s);
  const p = (await c.query("select invoice_paid_cents($1) v", [invoice])).rows[0].v as number;
  return Math.max(0, total - credit - p);
});
const byRef = (c: Client, ref: string) => asService(c, async () =>
  (await c.query("select invoice_id, amount_cents, method from payments where gateway_ref=$1", [ref])).rows[0] ?? null);

it("first ITN records the payment and pays the invoice; the replay is a no-op", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 95000 });
  expect(await outstanding(c, i)).toBe(95000);
  expect(await byRef(c, "PF-1089250")).toBeNull();

  const first = (await itnRecord(c, i, 95000, "PF-1089250")).rows[0].id;
  expect(await byRef(c, "PF-1089250")).toEqual({ invoice_id: i, amount_cents: 95000, method: "payfast" });
  expect(await outstanding(c, i)).toBe(0);
  expect(await status(c, i)).toBe("paid");

  // the route short-circuits on loadPaymentByRef, but if PayFast's retry raced past that the RPC itself is idempotent
  expect((await itnRecord(c, i, 95000, "PF-1089250")).rows[0].id).toBe(first);
  expect((await c.query("select 1 from payments where invoice_id=$1", [i])).rowCount).toBe(1);
  expect(await paid(c, i)).toBe(95000);
}));

it("the recorded row is a payfast gateway_ref payment with no manual reference and no recorder", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 95000 });
  await itnRecord(c, i, 95000, "PF-5");
  expect((await c.query("select method, gateway_ref, reference, recorded_by, status from payments where invoice_id=$1", [i])).rows[0])
    .toEqual({ method: "payfast", gateway_ref: "PF-5", reference: null, recorded_by: null, status: "succeeded" });
}));

it("same ref with a different amount or another invoice is ref_conflict and records nothing", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 95000 }), j = await mkInvoice(c, p1, { total: 95000 });
  await itnRecord(c, i, 50000, "PF-7");
  await expect(itnRecord(c, i, 50001, "PF-7")).rejects.toThrow(/ref_conflict/);
  await expect(itnRecord(c, j, 50000, "PF-7")).rejects.toThrow(/ref_conflict/);
  expect(await paid(c, i)).toBe(50000);
  expect(await paid(c, j)).toBe(0);
  expect(await status(c, i)).toBe("part_paid");
}));

it("outstanding reflects part payments and credit notes, and the ITN pays exactly the rest", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 100000 });
  await asUser(c, psy, () => c.query("select record_payment($1,'eft',30000,'EFT-1',null)", [i]));
  await asUser(c, psy, () => c.query("insert into credit_notes(invoice_id,amount_cents,reason) values ($1,10000,'goodwill')", [i]));
  expect(await outstanding(c, i)).toBe(60000);
  await itnRecord(c, i, 60000, "PF-60");
  expect(await outstanding(c, i)).toBe(0);
  expect(await status(c, i)).toBe("paid");
}));

it("overpay and a closed invoice are refused (the route maps both to 200 duplicate-or-closed)", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 1000 });
  await expect(itnRecord(c, i, 1001, "PF-O")).rejects.toThrow(/overpay/);
  await itnRecord(c, i, 1000, "PF-A");
  await expect(itnRecord(c, i, 1000, "PF-B")).rejects.toThrow(/invoice_not_payable/);
  const v = await mkInvoice(c, p1, { total: 1000, status: "void" });
  await expect(itnRecord(c, v, 1000, "PF-V")).rejects.toThrow(/invoice_not_payable/);
  const d = await mkInvoice(c, p1, { total: 1000, status: "draft" });
  await expect(itnRecord(c, d, 1000, "PF-D")).rejects.toThrow(/invoice_not_payable/);
  expect(await paid(c, i)).toBe(1000);
}));

it("an unknown invoice id is unknown_invoice; a missing ref or a zero amount is refused", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await expect(itnRecord(c, "00000000-0000-4000-8000-000000000000", 100, "PF-U")).rejects.toThrow(/unknown_invoice/);
  await expect(itnRecord(c, i, 0, "PF-Z")).rejects.toThrow(/invalid_amount/);
  await expect(asService(c, () => c.query("select record_payment(p_invoice => $1, p_method => 'payfast', p_amount => 100, p_ref => null, p_by => null)", [i]))).rejects.toThrow(/ref_required/);
}));

it("the audit_append call the core makes for rejections: service role only, null actor allowed, detail stored as given", () => withClient(async (c) => {
  const call = () => c.query("select audit_append(null, 'system', 'payfast.itn.rejected', 'payments', null, $1::jsonb)", [JSON.stringify({ reason: "bad_ip" })]);
  await asService(c, call);
  expect((await c.query("select actor_id, role, entity, detail from audit_log where action='payfast.itn.rejected'")).rows)
    .toEqual([{ actor_id: null, role: "system", entity: "payments", detail: { reason: "bad_ip" } }]);
  const { u1 } = await seed(c);
  await expect(asUser(c, u1, call)).rejects.toThrow(/permission denied/);
}));
