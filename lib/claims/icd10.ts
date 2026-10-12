import { cleanSearch } from "@/lib/patients/search";

export type Icd10 = { code: string; description: string };

/** A code as typed in the database: a letter, two digits, and an optional dot with up to four more characters (F41.1, Z63.0, F32). */
export const ICD10_FORMAT = /^[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?$/;
export const MAX_ICD10 = 12;

export const ICD10_QUERY_MAX = 40;
export const ICD10_RESULTS_MAX = 50;

/**
 * The words of an ICD-10 search box, made safe for a PostgREST filter by the same sanitiser the patient search uses (it drops % _ * , ( )  " ' . : and
 * collapses spaces; so "F41.1" becomes the words "f41" and "1"). At most 5 words.
 */
export const icd10SearchWords = (query: string): string[] => cleanSearch(query).toLowerCase().split(" ").filter(Boolean).slice(0, 5);

/** The PostgREST `or` filter for one search word: it must appear in the code or in the description. Words are ANDed by chaining one `or` per word. */
export const icd10WordFilter = (word: string): string => `code.ilike.%${word}%,description.ilike.%${word}%`;

/** Rows from the database as results for the picker: only well-formed code + description pairs, nothing else the row might carry, at most ICD10_RESULTS_MAX. */
export function mapIcd10Rows(rows: unknown): Icd10[] {
  if (!Array.isArray(rows)) return [];
  const out: Icd10[] = [];
  for (const r of rows) {
    const o = r && typeof r === "object" ? (r as Record<string, unknown>) : null;
    if (o && typeof o.code === "string" && ICD10_FORMAT.test(o.code) && typeof o.description === "string") out.push({ code: o.code, description: o.description });
    if (out.length >= ICD10_RESULTS_MAX) break;
  }
  return out;
}

/** The codes of a submitted list ("F41.1,F32.9"), upper-cased and de-duplicated; null when any entry is not shaped like a code or there are too many. */
export function parseIcd10List(raw: string | undefined): string[] | null {
  const parts = (raw ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const unique = [...new Set(parts)];
  if (unique.length > MAX_ICD10 || unique.some((c) => !ICD10_FORMAT.test(c))) return null;
  return unique;
}
