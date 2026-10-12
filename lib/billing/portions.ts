import { creditSum, type Credit } from "./types";

/**
 * What each side of an invoice should pay and has paid, plus ONE overall outstanding figure, all integer cents (R40).
 *  - expected: scheme_portion / patient_portion as issued.
 *  - paid: scheme side = payments with method medical_aid (remittances); patient side = every other method.
 *  - credits: each credit note belongs to the 'scheme' or the 'patient' portion (credit_notes.portion, 0017).
 *  - perPortion = expected - paid - credits of that side, never below zero, for an open invoice only (null otherwise).
 *  - outstanding = total - credits - paid, never below zero, and only for an issued / part paid invoice (0 otherwise). It does not depend on
 *    the portions: an over-paid side (say the patient paid before the scheme did) cannot hide what the other side still owes in this figure.
 */
export function portionSummary(o: {
  status: string; totalCents: number; schemeCents: number; patientCents: number; credits: Credit[]; payments: { method: string; amountCents: number }[];
}) {
  const schemePaid = o.payments.filter((p) => p.method === "medical_aid").reduce((s, p) => s + p.amountCents, 0);
  const patientPaid = o.payments.filter((p) => p.method !== "medical_aid").reduce((s, p) => s + p.amountCents, 0);
  const schemeCredit = creditSum(o.credits, "scheme"), patientCredit = creditSum(o.credits, "patient");
  const open = o.status === "issued" || o.status === "part_paid";
  return {
    schemeExpectedCents: o.schemeCents, patientExpectedCents: o.patientCents,
    schemePaidCents: schemePaid, patientPaidCents: patientPaid,
    schemeCreditCents: schemeCredit, patientCreditCents: patientCredit, creditCents: schemeCredit + patientCredit,
    outstandingCents: open ? Math.max(0, o.totalCents - schemeCredit - patientCredit - schemePaid - patientPaid) : 0,
    perPortion: open
      ? { schemeCents: Math.max(0, o.schemeCents - schemePaid - schemeCredit), patientCents: Math.max(0, o.patientCents - patientPaid - patientCredit) }
      : null,
  };
}
