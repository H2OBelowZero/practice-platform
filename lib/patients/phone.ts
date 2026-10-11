/**
 * Normalise a phone number to E.164. South African numbers become "+27" followed by nine digits:
 * "082 123 4567", "0821234567", "+27 82 123 4567", "27821234567", "0027821234567" and "+27 (0) 82 123 4567" all give "+27821234567".
 * Another country's number is kept when it is written with "+" or "00" (8 to 15 digits). Anything else returns null.
 */
export function normaliseZaPhone(raw: string): string | null {
  const s = raw.trim();
  let d = s.replace(/\D/g, "");
  if (d === "") return null;
  let intl = s.startsWith("+");
  if (!intl && d.startsWith("00")) { d = d.slice(2); intl = true; }
  if (!intl && d.length === 11 && d.startsWith("27")) intl = true;
  if (!intl) return /^0[1-9]\d{8}$/.test(d) ? `+27${d.slice(1)}` : null;
  if (d.startsWith("270")) d = `27${d.slice(3)}`; // "+27 (0) 82 ..."
  if (d.startsWith("27")) return /^27[1-9]\d{8}$/.test(d) ? `+${d}` : null;
  return /^[1-9]\d{7,14}$/.test(d) ? `+${d}` : null;
}

/** The spellings an older record might hold for a normalised number (for duplicate look-ups): "+27821234567", "0821234567", "27821234567". */
export function phoneVariants(e164: string): string[] {
  const m = /^\+27([1-9]\d{8})$/.exec(e164);
  return m ? [e164, `0${m[1]}`, `27${m[1]}`] : [e164];
}
