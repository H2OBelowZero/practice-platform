/** Characters that mean something in a PostgREST filter or an ILIKE pattern are dropped from the search text. */
export const cleanSearch = (q: string): string => q.replace(/[%_*,()\\"'.:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * One filter per search word, ANDed by the caller (each word must match somewhere), so "jane smith" or "jane@example" both work.
 * A word that is only digits (with optional +) also matches a phone number with the leading 0 or 27 dropped (at least 3 digits must remain), so "082 123" finds +2782123....
 * "P0012" or "12" finds patient number 12 by number only when it is the whole search.
 * Input must already have gone through cleanSearch. Returns the argument of PostgREST `.or(...)`.
 */
export function wordFilter(word: string): string {
  const w = word.toLowerCase();
  const cols = ["first_name", "last_name", "email"].map((c) => `${c}.ilike.%${w}%`);
  if (/^\+?\d+$/.test(w)) {
    // a number: match phones without their leading 0 / 27 / +27, but never on fewer than 3 digits (that would be `ilike %%`, i.e. everyone)
    const rest = w.replace(/^\+?(27|0)/, "");
    if (rest.length >= 3) cols.push(`phone.ilike.%${rest}%`);
  } else cols.push(`phone.ilike.%${w}%`);
  return cols.join(",");
}

/** The patient number meant by a whole search such as "P0012", "p-12" or "12" (at most 9 digits), else null. */
export function patientNumberQuery(q: string): number | null {
  const m = /^p?-?(\d{1,9})$/i.exec(q.trim());
  return m ? Number(m[1]) : null;
}
