import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { makeItnDeps } from "@/lib/payments/itn-deps";

/** R34 call-site audit: the exact DB calls the ITN makes, named parameters included, against 0005_billing.sql / 0007_audit_app.sql. */
function fake(res: { rpc?: Record<string, { data?: unknown; error?: { code?: string; message: string } | null }>; ref?: unknown; refErr?: boolean; task?: unknown; taskErr?: boolean }) {
  const log: { fn: string; args: unknown }[] = [];
  const client = {
    from(t: string) {
      log.push({ fn: "from:" + t, args: null });
      return { select: (cols: string) => ({ eq: (c: string, v: string) => {
        log.push({ fn: `select:${t}:${cols}:${c}`, args: v });
        if (t === "payments") return { maybeSingle: async () => (res.refErr ? { data: null, error: { code: "X", message: "bad" } } : { data: res.ref ?? null, error: null }) };
        if (t === "tasks") return { maybeSingle: async () => (res.taskErr ? { data: null, error: { code: "X", message: "tasks bad" } } : { data: res.task ?? null, error: null }) };
        if (t === "invoices") return { maybeSingle: async () => ({ data: { id: v, status: "issued", total_cents: 100000 }, error: null }) };
        return Promise.resolve({ data: [{ amount_cents: 5000 }], error: null });
      } }) };
    },
    async rpc(fn: string, args: unknown) { log.push({ fn: "rpc:" + fn, args }); const r = res.rpc?.[fn]; return { data: r?.data ?? 20000, error: r?.error ?? null }; },
  };
  return { client: client as unknown as SupabaseClient, log };
}
const env = { merchantId: "m" };
const noValidate = async () => true;

describe("makeItnDeps issues exactly the documented DB calls", () => {
  it("record_payment: named params p_invoice, p_method, p_amount, p_ref, p_by (SQL: uuid, text, int, text, uuid)", async () => {
    const { client, log } = fake({});
    const r = await makeItnDeps(client, env, noValidate).recordPayment({ invoiceId: "i-1", amountCents: 95000, ref: "PF-77" });
    expect(r).toEqual({ ok: true });
    expect(log).toEqual([{ fn: "rpc:record_payment", args: { p_invoice: "i-1", p_method: "payfast", p_amount: 95000, p_ref: "PF-77", p_by: null } }]);
  });
  it("record_payment errors come back as the DB message", async () => {
    const { client } = fake({ rpc: { record_payment: { error: { code: "P0001", message: "overpay" } } } });
    expect(await makeItnDeps(client, env, noValidate).recordPayment({ invoiceId: "i", amountCents: 1, ref: "PF-1" })).toEqual({ ok: false, error: "overpay" });
  });
  it("audit_append: (p_actor null, p_role 'system', p_action, p_entity, p_entity_id null, p_detail)", async () => {
    const { client, log } = fake({});
    await makeItnDeps(client, env, noValidate).audit({ action: "payfast.itn.rejected", detail: { reason: "bad_ip" } });
    expect(log).toEqual([{ fn: "rpc:audit_append", args: { p_actor: null, p_role: "system", p_action: "payfast.itn.rejected", p_entity: "payments", p_entity_id: null, p_detail: { reason: "bad_ip" } } }]);
  });
  it("audit_append failure throws (the core swallows it)", async () => {
    const { client } = fake({ rpc: { audit_append: { error: { code: "42501", message: "denied" } } } });
    await expect(makeItnDeps(client, env, noValidate).audit({ action: "a", detail: {} })).rejects.toThrow(/denied/);
  });
  it("payment lookup by gateway_ref (payments.gateway_ref is unique)", async () => {
    const { client, log } = fake({ ref: { invoice_id: "i-1", amount_cents: 95000, method: "payfast" } });
    expect(await makeItnDeps(client, env, noValidate).loadPaymentByRef("PF-77")).toEqual({ invoiceId: "i-1", amountCents: 95000, method: "payfast" });
    expect(log).toContainEqual({ fn: "select:payments:invoice_id,amount_cents,method:gateway_ref", args: "PF-77" });
    expect(await makeItnDeps(fake({}).client, env, noValidate).loadPaymentByRef("PF-0")).toBeNull();
    await expect(makeItnDeps(fake({ refErr: true }).client, env, noValidate).loadPaymentByRef("x")).rejects.toThrow(/bad/);
  });
  it("reconciliation task lookup by source payfast_unreconciled:<pf_payment_id>", async () => {
    const { client, log } = fake({ task: { id: "t1" } });
    expect(await makeItnDeps(client, env, noValidate).unreconciledExists("1089250")).toBe(true);
    expect(log).toContainEqual({ fn: "select:tasks:id:source", args: "payfast_unreconciled:1089250" });
    expect(await makeItnDeps(fake({}).client, env, noValidate).unreconciledExists("1")).toBe(false);
    await expect(makeItnDeps(fake({ taskErr: true }).client, env, noValidate).unreconciledExists("1")).rejects.toThrow(/tasks bad/);
  });
  it("raise_payfast_unreconciled: named params p_invoice, p_pf_payment_id, p_amount_cents, p_outstanding_cents, p_reason (SQL: uuid, text, int, int, text)", async () => {
    const { client, log } = fake({});
    await makeItnDeps(client, env, noValidate).raiseUnreconciled({ invoiceId: "i-1", pfPaymentId: "77", amountCents: 95000, outstandingCents: 0, reason: "invoice_not_payable" });
    expect(log).toEqual([{ fn: "rpc:raise_payfast_unreconciled", args: { p_invoice: "i-1", p_pf_payment_id: "77", p_amount_cents: 95000, p_outstanding_cents: 0, p_reason: "invoice_not_payable" } }]);
  });
  it("raise_payfast_unreconciled failure throws (the core answers 500)", async () => {
    const { client } = fake({ rpc: { raise_payfast_unreconciled: { error: { code: "P0001", message: "unknown_invoice" } } } });
    await expect(makeItnDeps(client, env, noValidate).raiseUnreconciled({ invoiceId: "i", pfPaymentId: "1", amountCents: 1, outstandingCents: 0, reason: "overpay" })).rejects.toThrow(/unknown_invoice/);
  });
  it("invoice balance: invoices(id,status,total_cents), credit_notes(amount_cents) and rpc invoice_paid_cents(p_invoice)", async () => {
    const { client, log } = fake({});
    expect(await makeItnDeps(client, env, noValidate).loadInvoice("i-1")).toEqual({ id: "i-1", status: "issued", outstandingCents: 100000 - 5000 - 20000 });
    expect(log.map((l) => l.fn)).toEqual(["from:invoices", "select:invoices:id,status,total_cents:id", "from:credit_notes", "select:credit_notes:amount_cents:invoice_id", "rpc:invoice_paid_cents"]);
    expect(log.at(-1)!.args).toEqual({ p_invoice: "i-1" });
  });
});
