/** South African rand from cents: 123450 -> "R 1 234,50". */
export function formatZar(cents: number) {
  const neg = cents < 0; const abs = Math.abs(cents);
  const rand = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}R ${rand},${String(abs % 100).padStart(2, "0")}`;
}

/** DB `int` ceiling for cents columns. */
const MAX_CENTS = 2_147_483_647;

/**
 * Parse a rand amount typed by a person into integer cents, or null when it is not a clean amount.
 * Accepts "1234.50", "1234,5", "1 234,50", "R1234", "R 1 234,50" (spaces only as thousands separators in groups of three).
 * Rejects empty, negative, more than 2 decimals, a comma/dot thousands separator, exponents and anything above the DB int range.
 * Parsed from the string: no float arithmetic.
 */
export function parseZarToCents(input: string): number | null {
  const s = input.replace(/[\u00a0\u202f]/g, " ").trim().replace(/^R\s*/i, "");
  const m = /^(\d+|\d{1,3}(?: \d{3})+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const rand = Number(m[1].replace(/ /g, ""));
  const cents = rand * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}

/** Cents as the plain text a person edits in an amount box: 95000 -> "950,00" (round-trips through parseZarToCents). */
export function formatZarInput(cents: number): string {
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, "0")}`;
}
