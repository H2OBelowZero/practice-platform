import { isMinor } from "./age";

export type InviteSubject = { email: string | null; user_id: string | null; status: string; is_minor: boolean; date_of_birth: string | null };

/**
 * Why a patient cannot be invited to the portal right now (plain language), or null when they can.
 * A patient needs an email address, must not already have an account, must not be archived, and must not be a minor
 * (a child does not get their own login: a guardian is linked to the record instead).
 */
export function inviteBlock(p: InviteSubject, today: string): string | null {
  if (p.user_id) return "This patient already has a portal account.";
  if (p.status === "archived") return "Restore this patient before inviting them.";
  if (isMinor(p, today)) return "This patient is a minor. Minors do not get their own portal login: a parent or guardian is linked to the record instead.";
  if (!p.email) return "Add an email address on the Profile tab first.";
  return null;
}

/** Plain-language text for an error raised by invite_patient() (0011). Anything else is the generic failure. */
export function inviteErrorText(message: string | undefined): string {
  const m = message ?? "";
  if (m.includes("invite_too_soon")) return "An invitation was queued a moment ago. Please wait 10 minutes before inviting again.";
  if (m.includes("already_registered")) return "This patient already has a portal account.";
  if (m.includes("patient_archived")) return "Restore this patient before inviting them.";
  if (m.includes("patient_minor")) return "This patient is a minor. Minors do not get their own portal login: a parent or guardian is linked to the record instead.";
  if (m.includes("no_email")) return "Add an email address on the Profile tab first.";
  if (m.includes("patient_not_found") || m.includes("forbidden")) return "We could not find that patient.";
  return "We could not send the invitation. Please try again.";
}

/**
 * Changing the email address of a patient who was invited but has not registered cancels that invitation: it went to the old address,
 * and a new account is only linked to the record when the email it registers with matches the record. Staff invite again.
 */
const sameEmail = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
export const invitationVoidedByEmailChange = (p: { user_id: string | null; portal_invited_at: string | null; email: string | null }, newEmail: string | null): boolean =>
  p.user_id === null && p.portal_invited_at !== null && sameEmail(p.email, newEmail) === false;
