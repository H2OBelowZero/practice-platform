export type PayNow = { allowed: boolean; reason?: "paid" | "scheme_pending" | "not_payable"; amountCents: number };

/**
 * May the portal offer "Pay now" for the full balance, and for how much? (13c uses this; it must NOT use portions.ts.)
 * outstanding = total - credit notes - every succeeded payment, never below zero; that is the amount PayFast would be asked for
 * (the ITN accepts exactly the outstanding balance).
 * Allowed only when the invoice is issued or part paid, something is outstanding, and either the patient pays everything (self) or the whole
 * outstanding balance is something only the patient still owes: outstanding <= patient portion - the patient's own payments (non medical_aid).
 * So a medical aid / split invoice is payable online once the scheme has remitted its portion, or a credit note has written off what it
 * did not pay (the shortfall then falls to the patient). While the scheme still owes money the answer is 'scheme_pending'.
 */
export function payNowAllowed(o: {
  status: string; payerType: string; totalCents: number; creditCents: number; schemePortionCents: number; patientPortionCents: number;
  payments: { method: string; amountCents: number }[];
}): PayNow {
  const paid = o.payments.reduce((s, p) => s + p.amountCents, 0);
  const outstanding = Math.max(0, o.totalCents - o.creditCents - paid);
  if (o.status === "paid") return { allowed: false, reason: "paid", amountCents: outstanding };
  if (o.status !== "issued" && o.status !== "part_paid") return { allowed: false, reason: "not_payable", amountCents: outstanding };
  if (outstanding <= 0) return { allowed: false, reason: "paid", amountCents: 0 };
  if (o.payerType === "self") return { allowed: true, amountCents: outstanding };
  const patientPaid = o.payments.filter((p) => p.method !== "medical_aid").reduce((s, p) => s + p.amountCents, 0);
  const patientRemaining = Math.max(0, o.patientPortionCents - patientPaid);
  return outstanding <= patientRemaining ? { allowed: true, amountCents: outstanding } : { allowed: false, reason: "scheme_pending", amountCents: outstanding };
}
