import { sastDateLabel, sastTime } from "@/lib/time";
import { statusMeta } from "@/lib/status";

export type ApptEvent = { id: number; event: string; actor: string | null; detail: Record<string, unknown> | null; at: string };

const when = (iso: unknown) => (typeof iso === "string" ? `${sastDateLabel(iso)} at ${sastTime(iso)}` : "an earlier time");

/** Human wording for a row of appointment_events (see the trigger in 0002 and reschedule_appointment). */
export function eventText(e: Pick<ApptEvent, "event" | "detail">): string {
  const d = e.detail ?? {};
  if (e.event === "created") {
    const st = typeof d.status === "string" ? ` as ${statusMeta(d.status).label}` : "";
    return `Booked${st}${d.rescheduled_from ? " (moved from an earlier appointment)" : ""}`;
  }
  if (e.event === "rescheduled") return `Moved from ${when(d.from)} to ${when(d.to)}`;
  if (e.event.startsWith("status:")) {
    const s = e.event.slice(7);
    return s === "cancelled" ? "Cancelled" : s === "attended" ? "Marked attended" : s === "no_show" ? "Marked no-show" : s === "confirmed" ? "Confirmed" : `Status set to ${statusMeta(s).label}`;
  }
  return e.event.replace(/_/g, " ");
}

/** Why an appointment was cancelled, from cancel_reason. Known codes are reworded; free text written by staff is shown as written. */
export function cancelReasonText(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === "patient_cancelled") return "Cancelled by the patient";
  if (reason === "rescheduled") return "Moved to another time";
  if (reason === "staff_cancelled") return "Cancelled by the practice";
  return reason;
}
