/**
 * Outstanding on each side of an invoice, in integer cents. Scheme side: remittances (payments with method medical_aid) against the
 * medical aid portion. Patient side: every other payment against the patient portion. Credit notes reduce what the patient still owes
 * first, and only any credit beyond that reduces the scheme side. Both sides are floored at zero.
 */
export function portionBalances(o: { schemeCents: number; patientCents: number; creditCents: number; payments: { method: string; amountCents: number }[] }) {
  const schemePaid = o.payments.filter((p) => p.method === "medical_aid").reduce((s, p) => s + p.amountCents, 0);
  const patientPaid = o.payments.filter((p) => p.method !== "medical_aid").reduce((s, p) => s + p.amountCents, 0);
  const patientLeft = Math.max(0, o.patientCents - patientPaid);
  const creditToPatient = Math.min(o.creditCents, patientLeft);
  return {
    schemePaidCents: schemePaid, patientPaidCents: patientPaid,
    schemeOutstandingCents: Math.max(0, o.schemeCents - schemePaid - (o.creditCents - creditToPatient)),
    patientOutstandingCents: patientLeft - creditToPatient,
  };
}
