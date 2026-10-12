import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// startPayfastCheckout with a fake "RLS-filtered" Supabase client: the fake db holds exactly the rows the signed-in user is allowed to see
// (an invoice that is not theirs is simply absent, as it would be through RLS).
const h = vi.hoisted(() => ({
  requireRole: vi.fn(), audit: vi.fn(), db: {} as Record<string, unknown[]>, reads: [] as string[], user: { id: "", email: "" as string | null },
  service: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireRole: (...a: unknown[]) => h.requireRole(...a) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => h.service() }));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user.id ? h.user : null } }) },
    from: (table: string) => {
      h.reads.push(table);
      const rows = () => h.db[table] ?? [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      q.then = (res: (v: unknown) => unknown) => res({ data: rows(), error: null });
      return q;
    },
  }),
}));

import { startPayfastCheckout } from "@/app/portal/payments/actions";
import { SCHEME_PENDING_TEXT, PAY_ONLINE_UNAVAILABLE } from "@/lib/portal/payments";

const INV = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d";
const ME = "11111111-1111-4111-8111-111111111111";
const invoice = (o: Record<string, unknown> = {}) => ({
  id: INV, number: "INV-00007", patient_id: "p", status: "issued", payer_type: "self", total_cents: 95000, scheme_portion_cents: 0, patient_portion_cents: 95000, ...o,
});

beforeEach(() => {
  h.requireRole.mockReset(); h.requireRole.mockResolvedValue({ userId: ME, role: "patient" });
  h.audit.mockReset(); h.audit.mockResolvedValue(undefined);
  h.service.mockReset(); h.reads.length = 0;
  h.user.id = ME; h.user.email = "thandi@example.co.za";
  h.db = { invoices: [invoice()], payments: [], credit_notes: [], profiles: [{ display_name: "Thandi Nkosi" }] };
  vi.stubEnv("PAYFAST_MERCHANT_ID", "10000100"); vi.stubEnv("PAYFAST_MERCHANT_KEY", "46f0cd694581a"); vi.stubEnv("PAYFAST_PASSPHRASE", "x");
  vi.stubEnv("PAYFAST_SANDBOX", "true"); vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("startPayfastCheckout", () => {
  it("requires a signed-in patient or guardian before anything is read", async () => {
    h.requireRole.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(startPayfastCheckout(INV)).rejects.toThrow("NEXT_REDIRECT");
    expect(h.requireRole).toHaveBeenCalledWith(["patient", "guardian"]);
    expect(h.reads).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("builds a signed PayFast form for the outstanding balance, with the verified user's first name and email", async () => {
    h.db.payments = [{ method: "eft", amount_cents: 20000 }];
    const r = await startPayfastCheckout(INV);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("https://sandbox.payfast.co.za/eng/process");
    expect(r.fields).toMatchObject({
      m_payment_id: INV, amount: "750.00", item_name: "Invoice INV-00007", name_first: "Thandi", email_address: "thandi@example.co.za",
      notify_url: "http://localhost:3000/api/payfast/itn", return_url: `http://localhost:3000/portal/payments?paid=${INV}`,
    });
    expect(r.fields.signature).toMatch(/^[0-9a-f]{32}$/);
  });

  it("everything is read through the user's own client (never the service client), and the amount comes from those rows", async () => {
    await startPayfastCheckout(INV);
    expect(h.service).not.toHaveBeenCalled();
    expect(h.reads).toEqual(expect.arrayContaining(["invoices", "payments", "credit_notes", "profiles"]));
  });

  it("a guardian's checkout carries the guardian's own name and email, not the child's", async () => {
    h.requireRole.mockResolvedValue({ userId: ME, role: "guardian" });
    h.user.email = "mum@example.co.za"; h.db.profiles = [{ display_name: "Nomsa Dlamini" }];
    h.db.invoices = [invoice({ patient_id: "child" })];
    const r = await startPayfastCheckout(INV);
    expect(r.ok && r.fields).toMatchObject({ name_first: "Nomsa", email_address: "mum@example.co.za" });
    expect(JSON.stringify(r)).not.toContain("child");
  });

  it("the page's figure is only a check: a stale one is refused, the matching one is accepted, and a different one is never charged", async () => {
    expect(await startPayfastCheckout(INV, 1)).toMatchObject({ ok: false, error: expect.stringContaining("R 950,00") });
    expect(await startPayfastCheckout(INV, 99999999)).toMatchObject({ ok: false });
    const ok = await startPayfastCheckout(INV, 95000);
    expect(ok.ok && ok.fields.amount).toBe("950.00");
    const none = await startPayfastCheckout(INV);
    expect(none.ok && none.fields.amount).toBe("950.00");
    expect(await startPayfastCheckout(INV, "95000")).toMatchObject({ ok: false }); // not a number: refused as malformed
    expect(await startPayfastCheckout(INV, -5)).toMatchObject({ ok: false });
    expect(await startPayfastCheckout(INV, 950.5)).toMatchObject({ ok: false });
  });

  it("a medical aid invoice whose scheme part is still open is refused with the plain text, and no audit row", async () => {
    h.db.invoices = [invoice({ payer_type: "split", status: "part_paid", total_cents: 100000, scheme_portion_cents: 70000, patient_portion_cents: 30000 })];
    h.db.payments = [{ method: "medical_aid", amount_cents: 50000 }];
    h.db.credit_notes = [{ portion: "patient", amount_cents: 20000 }];
    expect(await startPayfastCheckout(INV)).toEqual({ ok: false, error: SCHEME_PENDING_TEXT });
    expect(h.audit).not.toHaveBeenCalled();
    h.db.credit_notes = [{ portion: "scheme", amount_cents: 20000 }];
    const r = await startPayfastCheckout(INV);
    expect(r.ok && r.fields.amount).toBe("300.00");
  });

  it("an invoice the user cannot see (RLS returns nothing), a draft, a paid and a void one are refused", async () => {
    h.db.invoices = [];
    expect(await startPayfastCheckout(INV)).toMatchObject({ ok: false, error: "We could not find that invoice." });
    for (const status of ["draft", "paid", "void"]) {
      h.db.invoices = [invoice({ status })];
      expect((await startPayfastCheckout(INV)).ok, status).toBe(false);
    }
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("a malformed invoice id is refused before any read", async () => {
    for (const bad of ["x", "", null, undefined, 5, { id: INV }, `${INV}; drop table invoices`]) expect((await startPayfastCheckout(bad)).ok, String(bad)).toBe(false);
    expect(h.reads).toEqual([]);
  });

  it("missing PayFast configuration is the friendly message, not an error", async () => {
    vi.stubEnv("PAYFAST_MERCHANT_ID", "");
    expect(await startPayfastCheckout(INV)).toEqual({ ok: false, error: PAY_ONLINE_UNAVAILABLE });
    vi.stubEnv("PAYFAST_MERCHANT_ID", "10000100"); vi.stubEnv("PAYFAST_SANDBOX", "false"); vi.stubEnv("PAYFAST_PASSPHRASE", "");
    expect(await startPayfastCheckout(INV)).toEqual({ ok: false, error: PAY_ONLINE_UNAVAILABLE });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("the session user must be the verified Auth user (a mismatch or no user is refused)", async () => {
    h.user.id = "99999999-9999-4999-8999-999999999999";
    expect((await startPayfastCheckout(INV)).ok).toBe(false);
    h.user.id = "";
    expect((await startPayfastCheckout(INV)).ok).toBe(false);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("audits payment.checkout_started with ids and the amount only; an audit failure does not stop the payment (best effort)", async () => {
    await startPayfastCheckout(INV);
    expect(h.audit).toHaveBeenCalledWith("payment.checkout_started", "invoices", INV, { invoice_id: INV, amount_cents: 95000 });
    h.audit.mockRejectedValue(new Error("audit down"));
    const r = await startPayfastCheckout(INV);
    expect(r.ok).toBe(true);
  });

  it("a database error is a generic message with no internals", async () => {
    h.user.id = ME;
    const original = h.db;
    h.db = new Proxy(original, { get: () => { throw new Error("secret connection string"); } });
    const r = await startPayfastCheckout(INV);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
