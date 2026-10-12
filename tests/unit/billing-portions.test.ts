import { describe, it, expect } from "vitest";
import { portionSummary } from "@/lib/billing/portions";
import { payNowAllowed } from "@/lib/billing/pay-now";
import { creditSum } from "@/lib/billing/types";
import { feeTaskItems, shouldShowExistingInvoice } from "@/lib/billing/fee-tasks";

const P = (method: string, amountCents: number) => ({ method, amountCents });
const C = (portion: "scheme" | "patient", amountCents: number) => ({ portion, amountCents });

describe("creditSum", () => {
  it("adds the credits of one portion", () => {
    const cs = [C("scheme", 100), C("patient", 7), C("scheme", 5)];
    expect(creditSum(cs, "scheme")).toBe(105);
    expect(creditSum(cs, "patient")).toBe(7);
    expect(creditSum([], "scheme")).toBe(0);
  });
});

describe("portionSummary (R40: credit notes are allocated to a portion)", () => {
  const base = { status: "issued", totalCents: 100000, schemeCents: 80000, patientCents: 20000, credits: [] };
  it("nothing paid: expected amounts, one overall outstanding, per-portion split shown", () => {
    expect(portionSummary({ ...base, payments: [] })).toEqual({
      schemeExpectedCents: 80000, patientExpectedCents: 20000, schemePaidCents: 0, patientPaidCents: 0, schemeCreditCents: 0, patientCreditCents: 0, creditCents: 0,
      outstandingCents: 100000, perPortion: { schemeCents: 80000, patientCents: 20000 },
    });
  });
  it("remittances count to the scheme side, every other method to the patient side", () => {
    const b = portionSummary({ ...base, status: "part_paid", payments: [P("medical_aid", 50000), P("eft", 5000), P("payfast", 5000), P("cash", 1000), P("card_machine", 1000)] });
    expect(b).toMatchObject({ schemePaidCents: 50000, patientPaidCents: 12000, outstandingCents: 38000, perPortion: { schemeCents: 30000, patientCents: 8000 } });
  });
  it("R1000 split 700/300, scheme remits 500, R200 SCHEME write-off => scheme owes 0, patient owes 300, outstanding 300", () => {
    const b = portionSummary({ status: "part_paid", totalCents: 100000, schemeCents: 70000, patientCents: 30000, credits: [C("scheme", 20000)], payments: [P("medical_aid", 50000)] });
    expect(b).toMatchObject({ outstandingCents: 30000, schemeCreditCents: 20000, patientCreditCents: 0, creditCents: 20000, perPortion: { schemeCents: 0, patientCents: 30000 } });
  });
  it("same, but the R200 credit is a PATIENT discount => scheme still owes 200, patient owes 100, outstanding still 300", () => {
    const b = portionSummary({ status: "part_paid", totalCents: 100000, schemeCents: 70000, patientCents: 30000, credits: [C("patient", 20000)], payments: [P("medical_aid", 50000)] });
    expect(b).toMatchObject({ outstandingCents: 30000, schemeCreditCents: 0, patientCreditCents: 20000, perPortion: { schemeCents: 20000, patientCents: 10000 } });
  });
  it("the overall outstanding does not depend on the allocation of the credits", () => {
    const o = { status: "issued", totalCents: 100000, schemeCents: 70000, patientCents: 30000, payments: [P("medical_aid", 10000)] };
    const x = portionSummary({ ...o, credits: [C("scheme", 5000), C("patient", 5000)] }).outstandingCents;
    expect(portionSummary({ ...o, credits: [C("scheme", 10000)] }).outstandingCents).toBe(x);
    expect(portionSummary({ ...o, credits: [C("patient", 10000)] }).outstandingCents).toBe(x);
    expect(x).toBe(80000);
  });
  it("a portion's figure never goes below zero (a side that paid or was credited more than expected)", () => {
    const b = portionSummary({ status: "part_paid", totalCents: 100000, schemeCents: 70000, patientCents: 30000, credits: [C("scheme", 70000)], payments: [P("eft", 35000)] });
    expect(b.perPortion).toEqual({ schemeCents: 0, patientCents: 0 });
    expect(b.outstandingCents).toBe(0);
    const c = portionSummary({ status: "part_paid", totalCents: 100000, schemeCents: 70000, patientCents: 30000, credits: [], payments: [P("medical_aid", 80000)] });
    expect(c.perPortion).toEqual({ schemeCents: 0, patientCents: 30000 });
    expect(c.outstandingCents).toBe(20000);
  });
  it("self-pay: all on the patient side; a patient credit reduces it", () => {
    const b = portionSummary({ status: "part_paid", totalCents: 95000, schemeCents: 0, patientCents: 95000, credits: [C("patient", 5000)], payments: [P("eft", 40000)] });
    expect(b).toMatchObject({ outstandingCents: 50000, perPortion: { schemeCents: 0, patientCents: 50000 } });
  });
  it("paid, void and draft invoices owe nothing and show no per-portion outstanding; overall is never negative", () => {
    for (const status of ["paid", "void", "draft"]) {
      const b = portionSummary({ ...base, status, payments: status === "paid" ? [P("eft", 100000)] : [] });
      expect(b.outstandingCents, status).toBe(0);
      expect(b.perPortion, status).toBeNull();
    }
    expect(portionSummary({ ...base, credits: [C("patient", 20000), C("scheme", 80000)], payments: [P("eft", 5000)] }).outstandingCents).toBe(0);
  });
});

describe("payNowAllowed (R40; used by the portal)", () => {
  const split = { status: "part_paid", payerType: "split", totalCents: 100000, schemePortionCents: 70000, patientPortionCents: 30000 };
  const self = (o: Partial<Parameters<typeof payNowAllowed>[0]> = {}) =>
    payNowAllowed({ status: "issued", payerType: "self", totalCents: 95000, schemePortionCents: 0, patientPortionCents: 95000, credits: [], payments: [], ...o });

  it("self-pay: allowed for the full outstanding balance; part payments and patient credits reduce it", () => {
    expect(self()).toEqual({ allowed: true, amountCents: 95000 });
    expect(self({ status: "part_paid", credits: [C("patient", 5000)], payments: [P("eft", 40000)] })).toEqual({ allowed: true, amountCents: 50000 });
    expect(self({ status: "part_paid", payments: [P("payfast", 94999)] })).toEqual({ allowed: true, amountCents: 1 });
  });
  it("split: the scheme has not paid and nothing is written off => scheme_pending for the whole outstanding balance", () => {
    expect(payNowAllowed({ ...split, credits: [], payments: [P("medical_aid", 50000)] })).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 50000 });
    expect(payNowAllowed({ ...split, status: "issued", credits: [], payments: [] })).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 100000 });
  });
  it("split 700/300, scheme remits 500 and a R200 SCHEME write-off credit => allowed for R300", () => {
    expect(payNowAllowed({ ...split, credits: [C("scheme", 20000)], payments: [P("medical_aid", 50000)] })).toEqual({ allowed: true, amountCents: 30000 });
  });
  it("split 700/300, scheme remits 500 and a R200 PATIENT goodwill credit => refused, scheme_pending, R300 outstanding (the scheme is not settled)", () => {
    expect(payNowAllowed({ ...split, credits: [C("patient", 20000)], payments: [P("medical_aid", 50000)] })).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 30000 });
  });
  it("split: the scheme paid its whole portion => allowed for the patient portion; the patient's own part-payments and discounts count", () => {
    expect(payNowAllowed({ ...split, credits: [], payments: [P("medical_aid", 70000)] })).toEqual({ allowed: true, amountCents: 30000 });
    expect(payNowAllowed({ ...split, credits: [], payments: [P("medical_aid", 70000), P("cash", 10000)] })).toEqual({ allowed: true, amountCents: 20000 });
    expect(payNowAllowed({ ...split, credits: [C("patient", 5000)], payments: [P("medical_aid", 70000), P("cash", 10000)] })).toEqual({ allowed: true, amountCents: 15000 });
  });
  it("split: remittances plus scheme credits together settle the scheme side", () => {
    expect(payNowAllowed({ ...split, credits: [C("scheme", 10000), C("scheme", 10000)], payments: [P("medical_aid", 50000)] })).toEqual({ allowed: true, amountCents: 30000 });
    expect(payNowAllowed({ ...split, credits: [C("scheme", 10000)], payments: [P("medical_aid", 50000)] })).toMatchObject({ allowed: false, reason: "scheme_pending" }); // R100 short
  });
  it("split: the whole scheme portion written off (no remittance at all) => allowed for the patient portion", () => {
    expect(payNowAllowed({ ...split, status: "issued", credits: [C("scheme", 70000)], payments: [] })).toEqual({ allowed: true, amountCents: 30000 });
  });
  it("medical_aid (patient portion 0): refused until the scheme is settled, and then there is nothing left to pay", () => {
    const ma = { status: "issued", payerType: "medical_aid", totalCents: 100000, schemePortionCents: 100000, patientPortionCents: 0 };
    expect(payNowAllowed({ ...ma, credits: [], payments: [] })).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 100000 });
    expect(payNowAllowed({ ...ma, credits: [C("scheme", 30000)], payments: [P("medical_aid", 50000)] })).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 20000 });
    expect(payNowAllowed({ ...ma, status: "paid", credits: [], payments: [P("medical_aid", 100000)] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
  });
  it("a patient payment above their portion cannot make the scheme's debt payable online", () => {
    const r = payNowAllowed({ ...split, credits: [], payments: [P("eft", 30000), P("payfast", 10000)] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("scheme_pending");
  });
  it("overpaid (more received and credited than the total): nothing to pay, never negative", () => {
    expect(self({ status: "part_paid", payments: [P("eft", 100000)] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
    expect(self({ credits: [C("patient", 96000)] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
    expect(payNowAllowed({ ...split, credits: [C("scheme", 70000), C("patient", 40000)], payments: [] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
  });
  it("zero outstanding on an open invoice is 'paid'; a paid invoice is never payable", () => {
    expect(self({ status: "part_paid", payments: [P("eft", 90000)], credits: [C("patient", 5000)] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
    expect(self({ status: "paid", payments: [P("eft", 95000)] })).toEqual({ allowed: false, reason: "paid", amountCents: 0 });
  });
  it("void and draft invoices are not payable, whatever the figures say", () => {
    expect(self({ status: "void" })).toMatchObject({ allowed: false, reason: "not_payable" });
    expect(self({ status: "draft" })).toMatchObject({ allowed: false, reason: "not_payable" });
    expect(payNowAllowed({ ...split, status: "draft", credits: [], payments: [] })).toMatchObject({ allowed: false, reason: "not_payable" });
  });
  it("amounts are integers equal to total - credits - paid", () => {
    const r = self({ totalCents: 123457, patientPortionCents: 123457, credits: [C("patient", 3)], payments: [P("cash", 7)] });
    expect(r.amountCents).toBe(123447);
    expect(Number.isInteger(r.amountCents)).toBe(true);
  });
  it("an unknown payer type is treated like a medical aid invoice (fails closed) rather than self-pay", () => {
    expect(payNowAllowed({ status: "issued", payerType: "weird", totalCents: 1000, schemePortionCents: 1000, patientPortionCents: 0, credits: [], payments: [] }).allowed).toBe(false);
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
