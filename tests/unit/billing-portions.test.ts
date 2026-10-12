import { describe, it, expect } from "vitest";
import { portionSummary } from "@/lib/billing/portions";
import { payNowAllowed } from "@/lib/billing/pay-now";
import { feeTaskItems, shouldShowExistingInvoice } from "@/lib/billing/fee-tasks";

const P = (method: string, amountCents: number) => ({ method, amountCents });

describe("portionSummary", () => {
  const base = { status: "issued", totalCents: 100000, schemeCents: 80000, patientCents: 20000, creditCents: 0 };
  it("nothing paid: expected amounts, one overall outstanding, per-portion split shown", () => {
    expect(portionSummary({ ...base, payments: [] })).toEqual({
      schemeExpectedCents: 80000, patientExpectedCents: 20000, schemePaidCents: 0, patientPaidCents: 0, creditCents: 0, outstandingCents: 100000,
      perPortion: { schemeCents: 80000, patientCents: 20000 },
    });
  });
  it("remittances count to the scheme side, every other method to the patient side", () => {
    const b = portionSummary({ ...base, status: "part_paid", payments: [P("medical_aid", 50000), P("eft", 5000), P("payfast", 5000), P("cash", 1000), P("card_machine", 1000)] });
    expect(b).toMatchObject({ schemePaidCents: 50000, patientPaidCents: 12000, outstandingCents: 38000, perPortion: { schemeCents: 30000, patientCents: 8000 } });
  });
  it("the review scenario: R1000 split 700/300, scheme remits 500, the R200 shortfall is written off => R300 outstanding overall, no per-portion outstanding", () => {
    const b = portionSummary({ status: "part_paid", totalCents: 100000, schemeCents: 70000, patientCents: 30000, creditCents: 20000, payments: [P("medical_aid", 50000)] });
    expect(b.outstandingCents).toBe(30000);
    expect(b.creditCents).toBe(20000); // its own figure, not taken off a portion
    expect(b.schemePaidCents).toBe(50000);
    expect(b.perPortion).toBeNull(); // so nobody reads "scheme outstanding R200"
  });
  it("credit notes never change the per-side expected or paid figures", () => {
    const b = portionSummary({ ...base, creditCents: 25000, payments: [] });
    expect(b).toMatchObject({ schemeExpectedCents: 80000, patientExpectedCents: 20000, schemePaidCents: 0, patientPaidCents: 0, outstandingCents: 75000, perPortion: null });
  });
  it("paid, void and draft invoices owe nothing and show no per-portion outstanding; overall is never negative", () => {
    for (const status of ["paid", "void", "draft"]) {
      const b = portionSummary({ ...base, status, payments: status === "paid" ? [P("eft", 100000)] : [] });
      expect(b.outstandingCents, status).toBe(0);
      expect(b.perPortion, status).toBeNull();
    }
    expect(portionSummary({ ...base, creditCents: 100000, payments: [P("eft", 5000)] }).outstandingCents).toBe(0);
  });
});

describe("payNowAllowed (used by the portal in 13c)", () => {
  const split = { status: "part_paid", payerType: "split", totalCents: 100000, schemePortionCents: 70000, patientPortionCents: 30000 };
  it("self-pay: allowed for the full outstanding balance", () => {
    expect(payNowAllowed({ status: "issued", payerType: "self", totalCents: 95000, creditCents: 0, schemePortionCents: 0, patientPortionCents: 95000, payments: [] })).toEqual({ allowed: true, amountCents: 95000 });
    expect(payNowAllowed({ status: "part_paid", payerType: "self", totalCents: 95000, creditCents: 5000, schemePortionCents: 0, patientPortionCents: 95000, payments: [P("eft", 40000)] })).toEqual({ allowed: true, amountCents: 50000 });
  });
  it("split: the scheme has not paid and nothing is written off => scheme_pending for the whole outstanding balance", () => {
    expect(payNowAllowed({ ...split, creditCents: 0, payments: [P("medical_aid", 50000)] })).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 50000 });
    expect(payNowAllowed({ ...split, status: "issued", creditCents: 0, payments: [] })).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 100000 });
  });
  it("split: scheme remitted 500, the R200 shortfall written off by a credit note => allowed for R300", () => {
    expect(payNowAllowed({ ...split, creditCents: 20000, payments: [P("medical_aid", 50000)] })).toEqual({ allowed: true, amountCents: 30000 });
  });
  it("split: the scheme paid its whole portion => allowed for the patient portion; the patient's own part-payments count", () => {
    expect(payNowAllowed({ ...split, creditCents: 0, payments: [P("medical_aid", 70000)] })).toEqual({ allowed: true, amountCents: 30000 });
    expect(payNowAllowed({ ...split, creditCents: 0, payments: [P("medical_aid", 70000), P("cash", 10000)] })).toEqual({ allowed: true, amountCents: 20000 });
  });
  it("medical_aid (patient portion 0): allowed only once nothing is left for the scheme to pay", () => {
    const ma = { status: "issued", payerType: "medical_aid", totalCents: 100000, schemePortionCents: 100000, patientPortionCents: 0 };
    expect(payNowAllowed({ ...ma, creditCents: 0, payments: [] })).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 100000 });
    expect(payNowAllowed({ ...ma, status: "paid", creditCents: 0, payments: [P("medical_aid", 100000)] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
  });
  it("a patient payment above their portion cannot make the scheme's debt payable online", () => {
    expect(payNowAllowed({ ...split, creditCents: 0, payments: [P("eft", 30000), P("payfast", 10000)] }).allowed).toBe(false);
  });
  it("paid, void and draft invoices are never payable; zero outstanding is 'paid'", () => {
    const o = { payerType: "self", totalCents: 50000, creditCents: 0, schemePortionCents: 0, patientPortionCents: 50000 };
    expect(payNowAllowed({ ...o, status: "paid", payments: [P("eft", 50000)] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
    expect(payNowAllowed({ ...o, status: "void", payments: [] })).toMatchObject({ allowed: false, reason: "not_payable" });
    expect(payNowAllowed({ ...o, status: "draft", payments: [] })).toMatchObject({ allowed: false, reason: "not_payable" });
    expect(payNowAllowed({ ...o, status: "part_paid", creditCents: 50000, payments: [] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
    expect(payNowAllowed({ ...o, status: "issued", creditCents: 60000, payments: [] }).amountCents).toBe(0); // never negative
  });
  it("amounts are integers equal to total - credit - paid", () => {
    const r = payNowAllowed({ status: "issued", payerType: "self", totalCents: 123457, creditCents: 3, schemePortionCents: 0, patientPortionCents: 123457, payments: [P("cash", 7)] });
    expect(r.amountCents).toBe(123447);
    expect(Number.isInteger(r.amountCents)).toBe(true);
  });
});

describe("fee tasks", () => {
  const T = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", P1 = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", A = "11111111-2222-4333-8444-555555555555";
  it("lists open late_cancel_fee tasks with the task link, the appointment date (SAST) and the patient; other sources are left out", () => {
    const items = feeTaskItems(
      [{ id: T, source: "late_cancel_fee", patient_id: P1, appointment_id: A, appointments: { starts_at: "2031-01-06T22:30:00Z" } }, // 7 Jan 2031 in SAST
       { id: A, source: "risk_flag:x", patient_id: P1, appointment_id: null },
       { id: P1, source: "late_cancel_fee", patient_id: null, appointment_id: A, appointments: [{ starts_at: "2031-01-06T08:00:00Z" }] }],
      new Map([[P1, "Jane Smith"]]));
    expect(items).toEqual([
      { id: T, href: `/app/billing/new?task=${T}`, text: "Late cancellation fee for Tue 7 Jan 2031, Jane Smith" },
      { id: P1, href: `/app/billing/new?task=${P1}`, text: "Late cancellation fee for Mon 6 Jan 2031" },
    ]);
  });
  it("a double submit (invoice or closed task already there) goes to the existing invoice, other errors do not", () => {
    expect(shouldShowExistingInvoice("appointment_has_invoice", true)).toBe(true);
    expect(shouldShowExistingInvoice("task_not_open", true)).toBe(true);
    expect(shouldShowExistingInvoice("task_not_open", false)).toBe(false);
    expect(shouldShowExistingInvoice("overpay", true)).toBe(false);
    expect(shouldShowExistingInvoice("generic", true)).toBe(false);
  });
});
