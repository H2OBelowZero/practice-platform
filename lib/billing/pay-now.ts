import { creditSum, type Credit } from "./types";

export type PayNow = { allowed: boolean; reason?: "paid" | "scheme_pending" | "not_payable"; amountCents: number };

/**
 * May the portal offer "Pay now" for the full balance, and for how much? (R39/R40; 13c uses this, never portions.ts.)
 * outstanding = total - credit notes - every succeeded payment, never below zero; that is the amount PayFast is asked for
 * (the ITN accepts exactly the outstanding balance).
 * Allowed iff the invoice is issued or part paid, something is outstanding, and either
 *  - the patient pays everything (payer_type self), or
 *  - the medical aid is settled (remittances + 'scheme' credit notes >= scheme portion) AND what is left is the patient's:
 *    outstanding <= patient portion - the patient's own payments (every method but medical_aid) - 'patient' credit notes.
 * A goodwill credit for the PATIENT therefore never makes the scheme's unpaid part payable online ('scheme_pending').
 */
export function payNowAllowed(o: {
  status: string; payerType: string; totalCents: number; schemePortionCents: number; patientPortionCents: number;
  credits: Credit[]; payments: { method: string; amountCents: number }[];
}): PayNow {
  const paid = o.payments.reduce((s, p) => s + p.amountCents, 0);
  const outstanding = Math.max(0, o.totalCents - creditSum(o.credits, "scheme") - creditSum(o.credits, "patient") - paid);
  if (o.status === "paid") return { allowed: false, reason: "paid", amountCents: outstanding };
  if (o.status !== "issued" && o.status !== "part_paid") return { allowed: false, reason: "not_payable", amountCents: outstanding };
  if (outstanding <= 0) return { allowed: false, reason: "paid", amountCents: 0 };
  if (o.payerType === "self") return { allowed: true, amountCents: outstanding };
  const remitted = o.payments.filter((p) => p.method === "medical_aid").reduce((s, p) => s + p.amountCents, 0);
  const schemeSettled = remitted + creditSum(o.credits, "scheme") >= o.schemePortionCents;
  const patientPaid = paid - remitted;
  const patientRemaining = Math.max(0, o.patientPortionCents - patientPaid - creditSum(o.credits, "patient"));
  return schemeSettled && outstanding <= patientRemaining
    ? { allowed: true, amountCents: outstanding }
    : { allowed: false, reason: "scheme_pending", amountCents: outstanding };
}
