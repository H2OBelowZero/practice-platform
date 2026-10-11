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
