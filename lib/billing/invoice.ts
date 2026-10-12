const MAX_CENTS = 2_147_483_647; // the DB columns are int

const isCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Invoice totals in integer cents. Prices are VAT-exclusive: VAT is charged on (subtotal - discount), rounded half-up
 * to the cent, using integer arithmetic only (the rate is held in basis points, so 15 and 14.5 are exact).
 * The discount is clamped to the subtotal, so total = subtotal - discount + vat always holds and is never negative.
 * Throws Error('invalid_amount') for negative, fractional, non-finite or int-overflowing inputs.
 */
export function computeInvoice(o: {
  lines: { quantity: number; unitCents: number }[]; discountCents: number; vatRegistered: boolean; vatRate: number;
}): { subtotal: number; discount: number; vat: number; total: number } {
  const bad = () => new Error("invalid_amount");
  if (!isCents(o.discountCents)) throw bad();
  let subtotal = 0;
  for (const l of o.lines) {
    if (!isCents(l.quantity) || !isCents(l.unitCents)) throw bad();
    const line = l.quantity * l.unitCents;
    if (!Number.isSafeInteger(line)) throw bad();
    subtotal += line;
    if (subtotal > MAX_CENTS) throw bad();
  }
  const rateBp = Math.round(o.vatRate * 100);
  if (!Number.isFinite(o.vatRate) || o.vatRate < 0 || o.vatRate > 100 || Math.abs(o.vatRate * 100 - rateBp) > 1e-6) throw bad(); // at most 2 decimals; a rate outside 0-100 is a typo
  const discount = Math.min(o.discountCents, subtotal);
  const taxable = subtotal - discount;
  const vat = o.vatRegistered ? Math.floor((taxable * rateBp + 5000) / 10000) : 0; // half-up
  const total = taxable + vat;
  if (total > MAX_CENTS) throw bad();
  return { subtotal, discount, vat, total };
}
