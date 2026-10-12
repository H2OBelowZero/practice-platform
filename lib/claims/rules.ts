import { addDays, sastDate } from "@/lib/time";

// Pure claim rules shared by the pages and the actions. The database has the last word (0005 claims_guard); these decide what the UI offers
// and give the plain-language reasons.

export const CLAIM_STATUSES = ["draft", "submitted", "accepted", "rejected", "part_paid", "paid"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const isClaimStatus = (s: unknown): s is ClaimStatus => typeof s === "string" && (CLAIM_STATUSES as readonly string[]).includes(s);

/** What a person can do with a claim in each status. `remit` = record a scheme payment (record_scheme_remittance accepts submitted, accepted and part_paid). */
export type ClaimAction = "edit" | "submit" | "accept" | "reject" | "resubmit" | "reopen" | "remit";
const ACTIONS: Record<ClaimStatus, ClaimAction[]> = {
  draft: ["edit", "submit"],
  submitted: ["accept", "reject", "remit"],
  accepted: ["remit"],
  rejected: ["resubmit", "reopen"],
  part_paid: ["remit"],
  paid: [],
};
export const claimActions = (status: string): ClaimAction[] => (isClaimStatus(status) ? ACTIONS[status] : []);

/** The claim status each status-changing action starts from; an action refuses to run from any other (so a stale page cannot do the wrong thing). */
export const ACTION_FROM = { submit: "draft", accept: "submitted", reject: "submitted", resubmit: "rejected", reopen: "rejected" } as const satisfies Partial<Record<ClaimAction, ClaimStatus>>;
/** The status each of those actions moves the claim to (the database allows exactly these moves). */
export const ACTION_TO = { submit: "submitted", accept: "accepted", reject: "rejected", resubmit: "submitted", reopen: "draft" } as const satisfies Partial<Record<ClaimAction, ClaimStatus>>;

export type Member = { valid_from: string | null; valid_to: string | null };
export type MemberState = "current" | "expired" | "upcoming";
/** A member is current on `today` (SAST date) when it has started (or has no start date) and has not ended (or has no end date). */
export function memberState(m: Member, today: string): MemberState {
  if (m.valid_from && m.valid_from > today) return "upcoming";
  if (m.valid_to && m.valid_to < today) return "expired";
  return "current";
}
export const isCurrentMember = (m: Member, today: string): boolean => memberState(m, today) === "current";

/**
 * Whether a claim may be marked submitted, and if not, every reason in plain language. The app requires this; the database does not
 * (a draft claim without codes is legal there, which is how the admin can open one).
 */
export function submitReadiness(o: { icdCount: number; memberCurrent: boolean; claimedCents: number; role: string }): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (o.icdCount < 1) missing.push(o.role === "psychologist" ? "Add at least one ICD-10 diagnosis code." : "A diagnosis code is needed, and diagnosis codes are added by the practitioner.");
  if (!o.memberCurrent) missing.push("The medical aid membership is not current. Check its dates on the patient's Medical aid tab, or choose another member.");
  if (!(o.claimedCents > 0)) missing.push("The amount claimed must be more than R 0,00.");
  return { ok: missing.length === 0, missing };
}

/** What is left of the scheme portion to claim: the portion minus every claim that is not rejected (the same rule as the database). `exceptId` leaves one claim out (the one being edited). */
export function claimableCents(schemeCents: number, claims: { id?: string; status: string; claimed_cents: number }[], exceptId?: string): number {
  const used = claims.filter((c) => c.status !== "rejected" && c.id !== exceptId).reduce((s, c) => s + c.claimed_cents, 0);
  return Math.max(0, schemeCents - used);
}

/** What the scheme has not yet paid on a claim (claimed minus the remittances recorded against it). */
export const unpaidCents = (claimedCents: number, remittedCents: number): number => Math.max(0, claimedCents - remittedCents);

/** Whole days from the SAST date of `iso` to `today` (never negative); null when there is no date. */
export function daysSince(iso: string | null | undefined, today: string): number | null {
  if (!iso) return null;
  const a = Date.parse(`${sastDate(iso)}T00:00:00Z`), b = Date.parse(`${today}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.max(0, Math.round((b - a) / 86_400_000));
}

export const STALE_DAYS = 30;
/** The instant before which a claim submitted earlier counts as waiting too long (SAST midnight, STALE_DAYS before today). */
export const staleBefore = (today: string): string => `${addDays(today, -STALE_DAYS)}T00:00:00+02:00`;
/** Submitted and still not answered or paid after more than STALE_DAYS days. */
export const isStale = (c: { status: string; submitted_at: string | null }, today: string): boolean =>
  c.status === "submitted" && (daysSince(c.submitted_at, today) ?? 0) > STALE_DAYS;
