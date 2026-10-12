/**
 * Task sources and what they mean. `tasks.source` is null/'manual' for a task a person typed in, otherwise one of:
 *   risk_flag:<note id>          clinical (psychologist only, RLS 0013)
 *   late_cancel_fee              bookings
 *   payfast_unreconciled:<pf id>, overdue_invoice:<invoice id>, claim_rejected      billing
 *   consent_withdrawn            forms and consent
 *   duplicate_patient, outbox_failed:<outbox id>      system
 * An unknown future source is "system" (shown, never hidden).
 */
export const TASK_GROUPS = [
  { value: "clinical", label: "Clinical risk" },
  { value: "billing", label: "Billing" },
  { value: "bookings", label: "Bookings" },
  { value: "forms", label: "Forms and consent" },
  { value: "system", label: "System" },
  { value: "manual", label: "Added by staff" },
] as const;
export type TaskGroup = (typeof TASK_GROUPS)[number]["value"];
export const TASK_GROUP_FILTERS = [{ value: "", label: "Any kind" }, ...TASK_GROUPS] as const;

const BILLING_PREFIXES = ["payfast_unreconciled:", "overdue_invoice:"];

export function taskGroup(source: string | null | undefined): TaskGroup {
  const s = source ?? "";
  if (s === "" || s === "manual") return "manual";
  if (s.startsWith("risk_flag:")) return "clinical";
  if (s === "claim_rejected" || BILLING_PREFIXES.some((p) => s.startsWith(p))) return "billing";
  if (s === "late_cancel_fee") return "bookings";
  if (s === "consent_withdrawn") return "forms";
  return "system";
}

export const groupLabel = (g: TaskGroup): string => TASK_GROUPS.find((x) => x.value === g)?.label ?? "System";
export const parseTaskGroup = (s: string | undefined): TaskGroup | "" => (TASK_GROUPS.some((g) => g.value === s) ? (s as TaskGroup) : "");

/**
 * PostgREST `.or(...)` argument selecting one group, or null for "any". Values are quoted so the colon in a source prefix is never read as syntax;
 * `*` is PostgREST's LIKE wildcard. The sources are constants here, never user input.
 */
export function groupFilter(g: TaskGroup | ""): string | null {
  switch (g) {
    case "clinical": return 'source.like."risk_flag:*"';
    case "billing": return 'source.like."payfast_unreconciled:*",source.like."overdue_invoice:*",source.eq.claim_rejected';
    case "bookings": return "source.eq.late_cancel_fee";
    case "forms": return "source.eq.consent_withdrawn";
    case "system": return 'source.eq.duplicate_patient,source.like."outbox_failed:*"';
    case "manual": return "source.is.null,source.eq.manual";
    default: return null;
  }
}

// ---- PayFast payments that could not be matched -----------------------------------------------------------------------------
export const isPayfastUnreconciled = (source: string | null | undefined): boolean => (source ?? "").startsWith("payfast_unreconciled:");

const REASON_TEXT: Record<string, string> = {
  amount_mismatch: "The amount paid did not match what was owing on the invoice.",
  invoice_not_payable: "The invoice no longer accepts payments (it was already paid, voided or credited).",
  overpay: "The payment was more than what was owing.",
};
export type PayfastDetails = { amountCents: number; outstandingCents: number; reason: string };

/** The figures the ITN stored in tasks.meta (0014): amounts in cents and a reason code. Null when meta does not look like that. */
export function payfastDetails(meta: unknown): PayfastDetails | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const amount = int(m.amount_cents), outstanding = int(m.outstanding_cents);
  if (amount === null || outstanding === null) return null;
  const reason = typeof m.reason === "string" && Object.hasOwn(REASON_TEXT, m.reason) ? REASON_TEXT[m.reason] : "The payment could not be matched to an invoice.";
  return { amountCents: amount, outstandingCents: outstanding, reason };
}

/** A line of plain explanation under a task whose title alone is not enough, or null. */
export function taskExplanation(source: string | null | undefined): string | null {
  const s = source ?? "";
  if (s.startsWith("outbox_failed:"))
    return "An email or message to a patient could not be delivered after several tries. Nothing was sent. Check the email settings; there is nothing to open here, so mark this done once you have looked into it.";
  if (s === "duplicate_patient") return "Two patient records look like the same person. Open the patient, compare, and archive or merge by hand.";
  if (s === "consent_withdrawn") return "A patient withdrew a consent. Check what that means for their care and for any sharing.";
  if (s.startsWith("risk_flag:")) return "Follow-up on a clinical note. The details are in the note, not here.";
  return null;
}
