/**
 * What each side of an invoice should pay and has paid, plus ONE overall outstanding figure, all integer cents.
 *  - expected: scheme_portion / patient_portion as issued.
 *  - paid: scheme side = payments with method medical_aid (remittances); patient side = every other method.
 *  - credit notes are NOT allocated to a portion (credit_notes has no portion column): they reduce the invoice as a whole.
 *  - outstanding = total - credits - paid, never below zero, and only for an issued / part paid invoice (0 otherwise).
 *  - perPortion (the "expected less paid" of each side) is given only for an open invoice with NO credit notes; with credit notes the split
 *    cannot be known (a credit may be a write-off of the scheme's shortfall or a discount for the patient), so it is null and the page shows "-".
 */
export function portionSummary(o: {
  status: string; totalCents: number; schemeCents: number; patientCents: number; creditCents: number; payments: { method: string; amountCents: number }[];
}) {
  const schemePaid = o.payments.filter((p) => p.method === "medical_aid").reduce((s, p) => s + p.amountCents, 0);
  const patientPaid = o.payments.filter((p) => p.method !== "medical_aid").reduce((s, p) => s + p.amountCents, 0);
  const open = o.status === "issued" || o.status === "part_paid";
  return {
    schemeExpectedCents: o.schemeCents, patientExpectedCents: o.patientCents,
    schemePaidCents: schemePaid, patientPaidCents: patientPaid,
    creditCents: o.creditCents,
    outstandingCents: open ? Math.max(0, o.totalCents - o.creditCents - schemePaid - patientPaid) : 0,
    perPortion: open && o.creditCents === 0
      ? { schemeCents: Math.max(0, o.schemeCents - schemePaid), patientCents: Math.max(0, o.patientCents - patientPaid) }
      : null,
  };
}
