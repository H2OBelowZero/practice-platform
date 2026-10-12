export type Icd10 = { code: string; description: string };

/** A code as typed in the database: a letter, two digits, and an optional dot with up to four more characters (F41.1, Z63.0, F32). */
export const ICD10_FORMAT = /^[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?$/;
export const MAX_ICD10 = 12;

/**
 * Codes that match a search: every word must appear in the code (with or without the dot, any case) or in the description.
 * "f41" finds F41.1 and F41.9, "f411" finds F41.1, "anxiety" and "anxiety disorder" find the anxiety codes. An empty search keeps everything.
 */
export function filterIcd10<T extends Icd10>(codes: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...codes];
  return codes.filter((c) => {
    const code = c.code.toLowerCase(), plain = code.replace(".", ""), desc = c.description.toLowerCase();
    return words.every((w) => code.includes(w) || plain.includes(w) || desc.includes(w));
  });
}

/** The codes of a submitted list ("F41.1,F32.9"), upper-cased and de-duplicated; null when any entry is not shaped like a code or there are too many. */
export function parseIcd10List(raw: string | undefined): string[] | null {
  const parts = (raw ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const unique = [...new Set(parts)];
  if (unique.length > MAX_ICD10 || unique.some((c) => !ICD10_FORMAT.test(c))) return null;
  return unique;
}
