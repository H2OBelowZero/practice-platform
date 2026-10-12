import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// The portal Payments server pages rendered with a fake "RLS-filtered" Supabase client: whatever is in h.db is what the signed-in user may read.
// This exercises the real page code (grouping, wording, who sees Pay now, what is never shown) without a database. The client component
// (PayNow) is rendered as its initial markup only; its click flow is covered by the e2e spec, which cannot run here (R13).
const h = vi.hoisted(() => ({ db: {} as Record<string, unknown[]>, role: "patient", failTable: "" }));
vi.mock("@/lib/auth/session", () => ({ requireRole: async () => ({ userId: "me", role: h.role }) }));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    from: (table: string) => {
      const rows = () => h.db[table] ?? [];
      const err = () => (h.failTable === table ? { code: "XX000", message: "boom secret" } : null);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: err() ? null : rows()[0] ?? null, error: err() });
      q.then = (res: (v: unknown) => unknown) => res({ data: err() ? null : rows(), error: err() });
      return q;
    },
  }),
}));
vi.mock("@/app/portal/payments/actions", () => ({ startPayfastCheckout: vi.fn() }));

import PortalPayments from "@/app/portal/payments/page";
import PortalInvoice from "@/app/portal/payments/[invoiceId]/page";
import PortalReceipt from "@/app/portal/payments/[invoiceId]/receipts/[paymentId]/page";
import PortalHome from "@/app/portal/page";

const A = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", B = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", C = "11111111-2222-4333-8444-555555555555";
const PAY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const inv = (o: Record<string, unknown>) => ({
  id: A, number: "INV-00001", patient_id: "pat", status: "issued", payer_type: "self", issue_date: "2031-03-01", due_date: "2031-03-15",
  subtotal_cents: 95000, discount_cents: 0, vat_cents: 0, total_cents: 95000, scheme_portion_cents: 0, patient_portion_cents: 95000, outstanding_cents: 95000, ...o,
});
const render = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const list = (sp: { paid?: string } = {}) => render(PortalPayments({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  h.role = "patient"; h.failTable = "";
  h.db = {
    invoice_balances: [inv({})], payments: [], credit_notes: [], patients: [{ id: "pat", first_name: "Thandi", last_name: "Nkosi", user_id: "me" }],
    practices: [{ name: "Dr Example", registration_no: "PR 123", hpcsa_no: "PS 456", vat_registered: false, vat_rate: 15, late_cancel_fee_cents: 0, payment_instructions: "Bank: Example\nAcc: 123456" }],
  };
  vi.stubEnv("PAYFAST_MERCHANT_ID", "10000100"); vi.stubEnv("PAYFAST_MERCHANT_KEY", "46f0cd694581a"); vi.stubEnv("PAYFAST_PASSPHRASE", "x");
  vi.stubEnv("PAYFAST_SANDBOX", "true"); vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("/portal/payments", () => {
  it("shows the amount outstanding, the invoice with its figures, a Pay now with the PayFast line, and the EFT instructions", async () => {
    const out = await list();
    expect(out).toContain("R 950,00");
    expect(out).toContain("Invoice INV-00001");
    expect(out).toContain("Issued");
    expect(out).toContain("You will be taken to PayFast to pay <strong>R 950,00</strong>.");
    expect(out).toMatch(/<button[^>]*>.*Pay now<\/button>/);
    expect(out).toContain('href="/portal/payments/' + A + '"');
    expect(out).toContain("Bank: Example\nAcc: 123456");
    expect(out).toContain("R 950,00 can be paid online now.");
  });

  it("a medical aid invoice with its scheme part open shows the plain reason and no Pay now button", async () => {
    h.db.invoice_balances = [inv({ payer_type: "split", status: "part_paid", total_cents: 100000, scheme_portion_cents: 70000, patient_portion_cents: 30000, outstanding_cents: 50000 })];
    h.db.payments = [{ id: PAY, invoice_id: A, method: "medical_aid", amount_cents: 50000, received_on: "2031-03-05" }];
    h.db.credit_notes = [{ invoice_id: A, portion: "patient", amount_cents: 20000 }]; // a patient goodwill credit does not settle the scheme
    const out = await list();
    expect(out).toContain("Your medical aid is still processing its part of this invoice");
    expect(out).not.toContain("Pay now");
    expect(out).toContain("Nothing can be paid online at the moment.");
    expect(out).toContain("is still with your medical aid");
    // the scheme's own remittance is not listed as a patient payment with a receipt
    expect(out).not.toContain("/receipts/");
  });

  it("the same invoice with a scheme write-off is payable for the rest", async () => {
    h.db.invoice_balances = [inv({ payer_type: "split", status: "part_paid", total_cents: 100000, scheme_portion_cents: 70000, patient_portion_cents: 30000, outstanding_cents: 30000 })];
    h.db.payments = [{ id: PAY, invoice_id: A, method: "medical_aid", amount_cents: 50000, received_on: "2031-03-05" }];
    h.db.credit_notes = [{ invoice_id: A, portion: "scheme", amount_cents: 20000 }];
    expect(await list()).toContain("to pay <strong>R 300,00</strong>");
  });

  it("without PayFast configuration the button is replaced by the friendly text (no crash)", async () => {
    vi.stubEnv("PAYFAST_MERCHANT_KEY", "");
    const out = await list();
    expect(out).toContain("Online payment is not available right now — please pay by EFT or contact the practice.");
    expect(out).not.toContain("Pay now");
    expect(out).toContain("Bank: Example"); // EFT still offered
  });

  it("the return page: 'confirming' until the invoice is paid; 'Paid, thank you' after; unknown or malformed ids say nothing", async () => {
    expect(await list({ paid: A })).toContain("We&#x27;re confirming your payment. This usually takes a minute; refresh this page.");
    expect(await list({ paid: B })).not.toContain("confirming your payment"); // not one of the user's invoices
    expect(await list({ paid: "not-a-uuid" })).not.toContain("confirming your payment");
    h.db.invoice_balances = [inv({ status: "paid", outstanding_cents: 0 })];
    h.db.payments = [{ id: PAY, invoice_id: A, method: "payfast", amount_cents: 95000, received_on: "2031-03-05" }];
    const out = await list({ paid: A });
    expect(out).toContain("Paid, thank you.");
    expect(out).toContain("now paid in full");
    expect(out).toContain("/portal/payments/" + A + "/receipts/" + PAY);
  });

  it("I1: when the PayFast return URL names an invoice that is still unpaid, ONLY the confirming panel is shown for it: a Refresh link and no Pay now (no second payment)", async () => {
    h.db.invoice_balances = [inv({}), inv({ id: B, number: "INV-00002" })];
    const out = await list({ paid: A });
    expect(out).toContain("confirming your payment");
    expect(out).toContain(`href="/portal/payments?paid=${A}">Refresh</a>`);
    // exactly one Pay now (the other invoice), and the highlighted card says what is going on instead
    expect(out.match(/Pay now<\/button>/g)?.length).toBe(1);
    expect(out).toContain("Waiting for confirmation of your payment");
    expect(out).toContain(`pay <strong>R 950,00</strong>`);
  });
  it("I1: not highlighted => Pay now as normal; highlighted and paid => thank-you and no Pay now for it", async () => {
    expect(await list()).toMatch(/Pay now<\/button>/);
    expect(await list({ paid: B })).toMatch(/Pay now<\/button>/); // an id that is not the user's changes nothing
    h.db.invoice_balances = [inv({ status: "paid", outstanding_cents: 0 })];
    h.db.payments = [{ id: PAY, invoice_id: A, method: "payfast", amount_cents: 95000, received_on: "2031-03-05" }];
    const out = await list({ paid: A });
    expect(out).toContain("Paid, thank you.");
    expect(out).not.toContain("Pay now");
  });
  it("M2: an old medical aid invoice gets the neutral sentence instead of the 'still processing' one", async () => {
    h.db.invoice_balances = [inv({ payer_type: "medical_aid", issue_date: "2000-01-01", due_date: "2000-01-15", total_cents: 100000, scheme_portion_cents: 100000, patient_portion_cents: 0, outstanding_cents: 100000 })];
    const out = await list();
    expect(out).toContain("This invoice can&#x27;t be paid online yet. Please contact the practice if you have any questions.");
    expect(out).not.toContain("still processing");
  });
  it("the return page never marks anything paid by itself: a query string alone on an unpaid invoice stays 'confirming'", async () => {
    const out = await list({ paid: A });
    expect(out).not.toContain("Paid, thank you.");
  });

  it("a guardian sees the child's first name on each invoice and in the receipts list", async () => {
    h.role = "guardian";
    h.db.patients = [{ id: "pat", first_name: "Sipho", last_name: "Dlamini", user_id: "someone-else" }];
    h.db.invoice_balances = [inv({ status: "paid", outstanding_cents: 0 })];
    h.db.payments = [{ id: PAY, invoice_id: A, method: "eft", amount_cents: 95000, received_on: "2031-03-05" }];
    const out = await list();
    expect(out.match(/For <strong[^>]*>Sipho<\/strong>/g)?.length).toBe(1);
    expect(out).toContain("For Sipho"); // receipts list line
  });

  it("nothing to show (a guardian without the pay permission sees no rows) is explained, not an empty page", async () => {
    h.db.invoice_balances = [];
    const out = await list();
    expect(out).toContain("There are no invoices to show yet");
    expect(out).toContain("You have nothing to pay right now.");
  });

  it("an unreadable database shows an error notice and no figures, without leaking the error", async () => {
    h.failTable = "payments";
    const out = await list();
    expect(out).toContain("We could not load your invoices");
    expect(out).not.toContain("boom secret");
    expect(out).not.toContain("R 950,00");
  });

  it("default EFT wording when the practice has none", async () => {
    h.db.practices = [{ name: "Dr Example", registration_no: null, hpcsa_no: null, vat_registered: false, vat_rate: 15, late_cancel_fee_cents: 0, payment_instructions: "  " }];
    expect(await list()).toContain("Please contact the practice for EFT details.");
  });

  it("overdue invoices say so in words", async () => {
    h.db.invoice_balances = [inv({ due_date: "2000-01-01" })];
    expect(await list()).toContain("Overdue");
  });
});

describe("/portal/payments/[invoiceId]", () => {
  const detail = (id = A, sp: { paid?: string } = {}) => render(PortalInvoice({ params: Promise.resolve({ invoiceId: id }), searchParams: Promise.resolve(sp) }));
  const withLines = () => {
    h.db.invoices = [inv({})];
    h.db.invoice_lines = [{ id: "l1", description: "Therapy session", quantity: 2, unit_cents: 47500 }];
  };

  it("lists lines, totals and payments with receipt links for the patient's own payments", async () => {
    withLines();
    h.db.payments = [{ id: PAY, method: "eft", reference: "MY REF", gateway_ref: null, amount_cents: 20000, received_on: "2031-03-05" }];
    const out = await detail();
    expect(out).toContain("Therapy session");
    expect(out).toContain("R 950,00");
    expect(out).toContain("MY REF");
    expect(out).toContain(`/portal/payments/${A}/receipts/${PAY}`);
    expect(out).toContain("to pay <strong>R 750,00</strong>");
  });

  it("shows the medical aid portion as plain figures: no claims, no ICD-10, no credit note reason", async () => {
    h.db.invoices = [inv({ payer_type: "split", status: "part_paid", total_cents: 100000, scheme_portion_cents: 70000, patient_portion_cents: 30000 })];
    h.db.invoice_lines = [];
    h.db.payments = [{ id: PAY, method: "medical_aid", reference: null, gateway_ref: "REM-1", amount_cents: 50000, received_on: "2031-03-05" }];
    h.db.credit_notes = [{ id: "c1", portion: "scheme", amount_cents: 20000, created_at: "2031-03-06T08:00:00Z", reason: "TOP-SECRET internal reason" }];
    h.db.claims = [{ icd10_codes: ["F41.1"], claim_ref: "CLAIM-SECRET" }];
    const out = await detail();
    expect(out).toContain("Your medical aid and your part");
    expect(out).toContain("Paid by your medical aid");
    expect(out).toContain("Amount your medical aid did not cover, written off");
    expect(out).not.toMatch(/TOP-SECRET|CLAIM-SECRET|F41\.1|ICD/i);
    expect(out).not.toContain("/receipts/"); // no receipt for the scheme's remittance
    expect(out).toContain("to pay <strong>R 300,00</strong>"); // scheme settled by remittance + write-off
  });

  it("a scheme part still open: reason shown, no Pay now", async () => {
    h.db.invoices = [inv({ payer_type: "medical_aid", total_cents: 100000, scheme_portion_cents: 100000, patient_portion_cents: 0 })];
    h.db.invoice_lines = [];
    const out = await detail();
    expect(out).toContain("Your medical aid is still processing its part of this invoice");
    expect(out).not.toContain("Pay now");
  });

  it("another person's invoice (RLS returns nothing), a malformed id and a draft are 404", async () => {
    h.db.invoices = [];
    await expect(detail()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    await expect(detail("nope")).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it("I1: ?paid=<this invoice> while it is unpaid: the confirming panel and a Refresh link replace Pay now", async () => {
    withLines();
    const out = await detail(A, { paid: A });
    expect(out).toContain("confirming your payment");
    expect(out).toContain(`href="/portal/payments/${A}?paid=${A}">Refresh</a>`);
    expect(out).not.toContain("Pay now");
    // a different or no ?paid= leaves Pay now alone
    expect(await detail(A, { paid: B })).toMatch(/Pay now<\/button>/);
    expect(await detail(A)).toMatch(/Pay now<\/button>/);
  });
  it("I1: ?paid=<this invoice> once it is paid: thank-you", async () => {
    h.db.invoices = [inv({ status: "paid" })]; h.db.invoice_lines = [];
    h.db.payments = [{ id: PAY, method: "payfast", reference: null, gateway_ref: "PF-1", amount_cents: 95000, received_on: "2031-03-05" }];
    expect(await detail(A, { paid: A })).toContain("Paid, thank you.");
  });
  it("M1: when part of the invoice could not be loaded the figures cannot be trusted, so there is no Pay now", async () => {
    withLines();
    h.failTable = "invoice_lines";
    const out = await detail();
    expect(out).toContain("could not be loaded");
    expect(out).not.toContain("Pay now");
  });
  it("a guardian sees whom the invoice is for", async () => {
    h.role = "guardian"; withLines();
    h.db.patients = [{ id: "pat", first_name: "Sipho", last_name: "D", user_id: "x" }];
    expect(await detail()).toMatch(/<dt[^>]*>For<\/dt><dd[^>]*>Sipho<\/dd>/);
  });
});

describe("/portal/payments/[invoiceId]/receipts/[paymentId]", () => {
  const receipt = (inv = A, pay = PAY) => render(PortalReceipt({ params: Promise.resolve({ invoiceId: inv, paymentId: pay }) }));
  const row = (o: Record<string, unknown> = {}) => ({ id: PAY, method: "payfast", reference: null, gateway_ref: "PF-777", amount_cents: 95000, received_on: "2031-03-05", status: "succeeded", ...o });

  it("prints the practice, patient, invoice, date, method, reference and amount", async () => {
    h.db.invoices = [inv({})]; h.db.payments = [row()];
    const out = await receipt();
    for (const t of ["Dr Example", "Practice number: PR 123", "HPCSA number: PS 456", "Thandi Nkosi", "INV-00001", "PayFast (online)", "PF-777", "R 950,00", "No VAT is charged on invoice INV-00001."]) expect(out, t).toContain(t);
    expect(out).toContain("no-print"); // the page header with the Print button is hidden when printing
  });
  it("404 for a payment that is not there, not succeeded, or the scheme's remittance; for malformed ids; for another person's invoice", async () => {
    const gone = /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/;
    h.db.invoices = [inv({})]; h.db.payments = [];
    await expect(receipt()).rejects.toThrow(gone);
    h.db.payments = [row({ status: "pending" })];
    await expect(receipt()).rejects.toThrow(gone);
    h.db.payments = [row({ method: "medical_aid", gateway_ref: "REM-1" })];
    await expect(receipt()).rejects.toThrow(gone);
    h.db.invoices = []; h.db.payments = [row()];
    await expect(receipt()).rejects.toThrow(gone);
    await expect(receipt("x", PAY)).rejects.toThrow(gone);
    await expect(receipt(A, "y")).rejects.toThrow(gone);
    await expect(receipt(C, B)).rejects.toThrow(gone);
  });
});

describe("/portal home", () => {
  it("shows the amount due and links to Payments; leaves the card out when the figures cannot be loaded", async () => {
    const out = await render(PortalHome());
    expect(out).toContain("Amount due");
    expect(out).toContain("R 950,00");
    expect(out).toContain('href="/portal/payments"');
    h.failTable = "invoice_balances";
    const bad = await render(PortalHome());
    expect(bad).not.toContain("Amount due");
    expect(bad).toContain("Book an appointment");
  });
});
