import type { Client } from "pg";
import { it, expect } from "vitest";
import { withClient, asService, asUser } from "./helpers";
import { seed, mkInvoice } from "./billing-helpers";

// raise_payfast_unreconciled: what the ITN route calls (via lib/payments/itn-deps.ts) for a genuine PayFast payment the invoice no longer accepts.
const raise = (c: Client, invoice: string, pf = "1089250", amount = 95000, outstanding = 0, reason = "invoice_not_payable") =>
  asService(c, () => c.query("select raise_payfast_unreconciled(p_invoice => $1, p_pf_payment_id => $2, p_amount_cents => $3, p_outstanding_cents => $4, p_reason => $5)",
    [invoice, pf, amount, outstanding, reason]));
const tasks = async (c: Client) => (await c.query("select title, priority, status, patient_id, source, meta from tasks where source like 'payfast_unreconciled:%' order by source")).rows;

it("creates one high-priority task carrying the patient and financial ids only", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 95000, status: "paid" });
  await raise(c, i, "1089250", 95000, 0, "invoice_not_payable");
  expect(await tasks(c)).toEqual([{
    title: "PayFast payment needs reconciliation", priority: "high", status: "open", patient_id: p1, source: "payfast_unreconciled:1089250",
    meta: { invoice_id: i, pf_payment_id: "1089250", reason: "invoice_not_payable", amount_cents: 95000, outstanding_cents: 0 },
  }]);
}));

it("is deduplicated per pf_payment_id: a replay is a no-op, another payment gets its own task", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 95000, status: "paid" });
  await raise(c, i, "5");
  await raise(c, i, "5");
  await raise(c, i, "5", 1, 1, "amount_mismatch"); // same payment id again, even with different details: still one task (first wins)
  expect((await tasks(c)).map((t) => t.source)).toEqual(["payfast_unreconciled:5"]);
  await raise(c, i, "6");
  expect(await tasks(c)).toHaveLength(2);
}));

it("psychologist and admin see the task; bookkeeper, associate, patient and guardian do not", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, g, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 95000, status: "paid" });
  await raise(c, i);
  const sees = (u: string) => asUser(c, u, async () => (await c.query("select source from tasks where source like 'payfast_unreconciled:%'")).rowCount);
  expect(await sees(psy)).toBe(1);
  expect(await sees(adm)).toBe(1);
  for (const u of [bk, assoc, u1, g]) expect(await sees(u)).toBe(0);
}));

it("only the service role may call it; anon, authenticated and public are denied", () => withClient(async (c) => {
  const { psy, adm, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 95000, status: "paid" });
  const sql = "select raise_payfast_unreconciled($1,'1',100,0,'overpay')";
  for (const u of [psy, adm]) await expect(asUser(c, u, () => c.query(sql, [i]))).rejects.toThrow(/permission denied/);
  await c.query("set local role anon");
  try { await expect(c.query(sql, [i])).rejects.toThrow(/permission denied/); } finally { await c.query("reset role"); }
  const priv = async (role: string) => (await c.query("select has_function_privilege($1, 'raise_payfast_unreconciled(uuid,text,int,int,text)', 'execute') ok", [role])).rows[0].ok;
  expect(await priv("service_role")).toBe(true);
  for (const r of ["public", "anon", "authenticated"]) expect(await priv(r), r).toBe(false);
  expect(await tasks(c)).toEqual([]);
}));

it("validates its inputs", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 95000, status: "paid" });
  await expect(raise(c, i, "abc")).rejects.toThrow(/invalid_pf_payment_id/);
  await expect(raise(c, i, "1; drop")).rejects.toThrow(/invalid_pf_payment_id/);
  await expect(raise(c, i, "1", 100, 0, "whatever")).rejects.toThrow(/invalid_reason/);
  await expect(raise(c, i, "1", 0)).rejects.toThrow(/invalid_amount/);
  await expect(raise(c, i, "1", 100, -1)).rejects.toThrow(/invalid_amount/);
  await expect(raise(c, "00000000-0000-4000-8000-000000000000", "1")).rejects.toThrow(/unknown_invoice/);
  expect(await tasks(c)).toEqual([]);
}));

it("works for every invoice state the ITN can meet (void, draft, part paid, paid)", () => withClient(async (c) => {
  const { p1 } = await seed(c);
  let n = 0;
  for (const status of ["void", "draft", "part_paid", "paid", "issued"]) {
    const i = await mkInvoice(c, p1, { total: 1000, status });
    await raise(c, i, String(++n), 1000, status === "issued" ? 500 : 0, status === "issued" ? "amount_mismatch" : "invoice_not_payable");
  }
  expect(await tasks(c)).toHaveLength(5);
}));
