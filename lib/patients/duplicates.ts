import { normaliseZaPhone } from "./phone";

export type PatientIdentity = { first_name: string; last_name: string; date_of_birth: string | null; email: string | null; phone: string | null };
export type ExistingPatient = PatientIdentity & { id: string; patient_number: number; status: string };
export type DuplicateReason = "email" | "phone" | "name_dob";
export type DuplicateMatch = ExistingPatient & { reasons: DuplicateReason[] };

export const REASON_TEXT: Record<DuplicateReason, string> = {
  email: "same email address", phone: "same phone number", name_dob: "same name and date of birth",
};

export const normaliseEmail = (e: string | null | undefined): string => (e ?? "").trim().toLowerCase();

/** Lower case, accents removed, punctuation dropped, spaces collapsed: "  Zoë  O'Brien-Smith " and "zoe obrien smith" are the same name. */
export function normaliseName(first: string, last: string): string {
  return `${first} ${last}`.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

const phoneKey = (p: string | null | undefined): string => (p ? normaliseZaPhone(p) ?? "" : "");

/**
 * Existing patients that look like the person being entered. A patient matches by the same normalised email, the same normalised
 * phone number, or exactly the same normalised name together with the same date of birth (name alone is never enough).
 * Pure: the caller decides which existing patients to pass in (archived ones should be included so they can be restored instead).
 */
export function findDuplicates(candidate: PatientIdentity, existing: ExistingPatient[]): DuplicateMatch[] {
  const email = normaliseEmail(candidate.email);
  const phone = phoneKey(candidate.phone);
  const name = normaliseName(candidate.first_name, candidate.last_name);
  const out: DuplicateMatch[] = [];
  for (const p of existing) {
    const reasons: DuplicateReason[] = [];
    if (email && normaliseEmail(p.email) === email) reasons.push("email");
    if (phone && phoneKey(p.phone) === phone) reasons.push("phone");
    if (name && candidate.date_of_birth && p.date_of_birth === candidate.date_of_birth && normaliseName(p.first_name, p.last_name) === name) reasons.push("name_dob");
    if (reasons.length) out.push({ ...p, reasons });
  }
  return out;
}
