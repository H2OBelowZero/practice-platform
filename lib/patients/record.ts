import type { SupabaseClient } from "@supabase/supabase-js";
import { findDuplicates, normaliseEmail, type DuplicateMatch, type ExistingPatient, type PatientIdentity } from "./duplicates";
import { phoneVariants } from "./phone";

/** Columns the staff patient record reads. Never `select *`: new columns must be added here on purpose. */
export const PATIENT_COLUMNS =
  "id, patient_number, first_name, last_name, date_of_birth, email, phone, language, comms_prefs, emergency_contact, referral_source, payer, status, is_minor, user_id, portal_invited_at, created_at";

export type PatientRecord = {
  id: string; patient_number: number; first_name: string; last_name: string; date_of_birth: string | null;
  email: string | null; phone: string | null; language: string | null;
  comms_prefs: { email?: boolean; sms?: boolean } | null;
  emergency_contact: { name?: string; phone?: string; relationship?: string } | null;
  referral_source: string | null; payer: string | null; status: string; is_minor: boolean;
  user_id: string | null; portal_invited_at: string | null; created_at: string;
};

const LIST_COLUMNS = "id, patient_number, first_name, last_name, date_of_birth, email, phone, status";
/** LIKE special characters in an email address (_ is common) are escaped so they match themselves. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Existing patients that look like `c`, read through the staff user's own client (RLS), archived ones included.
 * Three narrow queries (email, phone spellings, same date of birth) are merged and then judged by the pure findDuplicates.
 * Throws when a query fails: the caller must not create a patient without having checked.
 */
export async function lookupDuplicates(sb: SupabaseClient, c: PatientIdentity): Promise<DuplicateMatch[]> {
  const email = normaliseEmail(c.email);
  const queries = [
    email ? sb.from("patients").select(LIST_COLUMNS).ilike("email", escapeLike(email)).limit(20) : null,
    c.phone ? sb.from("patients").select(LIST_COLUMNS).in("phone", phoneVariants(c.phone)).limit(20) : null,
    c.date_of_birth ? sb.from("patients").select(LIST_COLUMNS).eq("date_of_birth", c.date_of_birth).limit(200) : null,
  ];
  const results = await Promise.all(queries.filter((q) => q !== null));
  const byId = new Map<string, ExistingPatient>();
  for (const r of results) {
    if (r.error) throw new Error("duplicate check failed");
    for (const p of (r.data ?? []) as ExistingPatient[]) byId.set(p.id, p);
  }
  return findDuplicates(c, [...byId.values()]);
}
