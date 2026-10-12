/**
 * Where a staff task leads. One place for every task source so the tasks page (Task 16), the dashboard and the billing screens agree.
 * Sources: late_cancel_fee, payfast_unreconciled:<pf id>, consent_withdrawn, claim_rejected, duplicate_patient, risk_flag:<note id>.
 * Returns null for a source we do not know (the task is shown without a link). Only ids from the database are put in the URL,
 * and only when they look like a uuid, so a bad row can never produce a link to somewhere else.
 */
export type TaskLinkInput = { id: string; source: string | null; patient_id?: string | null; appointment_id?: string | null; meta?: unknown };
export type TaskLink = { href: string; label: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ok = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

export function taskLink(t: TaskLinkInput): TaskLink | null {
  const src = t.source ?? "";
  const patient = (tab?: string): TaskLink | null => (ok(t.patient_id) ? { href: `/app/patients/${t.patient_id}${tab ? `?tab=${tab}` : ""}`, label: "Open patient" } : null);
  if (src === "late_cancel_fee") return ok(t.id) ? { href: `/app/billing/new?task=${t.id}`, label: "Create invoice" } : null;
  if (src.startsWith("payfast_unreconciled:")) {
    const inv = t.meta && typeof t.meta === "object" ? (t.meta as { invoice_id?: unknown }).invoice_id : undefined;
    return ok(inv) ? { href: `/app/billing/${inv}`, label: "Open invoice" } : patient("billing");
  }
  if (src === "consent_withdrawn") return patient("forms") && { href: patient("forms")!.href, label: "Open consents" };
  if (src === "claim_rejected") return patient("billing") && { href: patient("billing")!.href, label: "Open billing" }; // Task 14 may point this at the claim
  if (src === "duplicate_patient") return patient();
  if (src.startsWith("risk_flag:")) { const note = src.slice("risk_flag:".length); return ok(note) ? { href: `/app/notes/${note}`, label: "Open note" } : patient("notes"); }
  return null;
}
