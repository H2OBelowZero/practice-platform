import { formatZar } from "@/lib/money";
import { CLAIM_STATUSES } from "./rules";

// Wording and URL parsing for the claims pages. No clinical data is formatted here except the rejection reason in a timeline line (staff pages only).

export const CLAIM_STATUS_FILTERS = [{ value: "", label: "Any status" }, ...CLAIM_STATUSES.map((s) => ({ value: s as string, label: ({ draft: "Draft", submitted: "Submitted", accepted: "Accepted", rejected: "Rejected", part_paid: "Part paid", paid: "Paid" } as Record<string, string>)[s] }))];
export const parseClaimStatusFilter = (s: string | undefined): string => (CLAIM_STATUS_FILTERS.some((f) => f.value === s) ? (s as string) : "");

// Success messages shown after a redirect (?notice=code). Only codes in this map are ever rendered.
export const CLAIM_NOTICE_TEXT = {
  created: "The draft claim has been created. Check it, then mark it as submitted once you have sent it to the scheme.",
  saved: "The draft claim has been saved.",
  submitted: "The claim is marked as submitted. Record the scheme's answer here when it arrives.",
  resubmitted: "The claim is marked as submitted again.",
  accepted: "The claim is marked as accepted.",
  rejected: "The claim is marked as rejected. A follow-up task has been added for the practice.",
  reopened: "The claim is back in draft. Correct it, then mark it as submitted again.",
  remitted: "The scheme payment has been recorded.",
} as const;
export type ClaimNoticeCode = keyof typeof CLAIM_NOTICE_TEXT;
export const claimNotice = (code: string | undefined): string | undefined => (code !== undefined && Object.hasOwn(CLAIM_NOTICE_TEXT, code) ? CLAIM_NOTICE_TEXT[code as ClaimNoticeCode] : undefined);

export const MANUAL_SUBMISSION_NOTE = "Submission is tracked manually in this version: submit through your scheme or clearing house and record the outcome here.";

export type ClaimEvent = { event: string; from_status: string | null; to_status: string | null; detail?: unknown };

/** One line for a claim_events row, or null for a row the timeline leaves out (the part_paid / paid status change is shown by the remittance row that caused it). */
export function claimEventText(e: ClaimEvent): string | null {
  if (e.event === "remittance") return `Scheme payment recorded${e.to_status === "paid" ? ": claim fully paid" : e.to_status === "part_paid" ? ": claim part paid" : ""}`;
  if (!e.event.startsWith("status:")) return null;
  switch (e.to_status) {
    case "draft": return e.from_status === "rejected" ? "Returned to draft for correction" : "Draft claim started";
    case "submitted": return e.from_status === "draft" || e.from_status === null ? "Marked as submitted" : "Marked as submitted again";
    case "accepted": return "Marked as accepted";
    case "rejected": return "Marked as rejected";
    case "part_paid": case "paid": return null;
    default: return `Status changed to ${(e.to_status ?? "unknown").replace(/_/g, " ")}`;
  }
}

/** The extra line under a timeline entry: the rejection reason, or the amount and reference of a scheme payment. */
export function claimEventDetail(e: ClaimEvent): string | null {
  const d = e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as Record<string, unknown>) : null;
  if (!d) return null;
  if (e.event === "remittance" && typeof d.amount === "number") return `${formatZar(d.amount)}${typeof d.ref === "string" ? `, reference ${d.ref}` : ""}`;
  if (e.to_status === "rejected" && typeof d.reason === "string" && d.reason.trim()) return `Reason: ${d.reason}`;
  return null;
}
