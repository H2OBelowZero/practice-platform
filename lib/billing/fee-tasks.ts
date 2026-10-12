import { taskLink } from "@/lib/tasks/links";
import { sastDate, sastDayShort } from "@/lib/time";

/** Open late-cancellation fee tasks, as read from tasks (+ the appointment's start). */
export type FeeTaskRow = { id: string; source: string | null; patient_id: string | null; appointment_id: string | null; appointments?: { starts_at: string } | { starts_at: string }[] | null };
export type FeeTaskItem = { id: string; href: string; text: string };

export const FEE_TASK_SELECT = "id, source, patient_id, appointment_id, appointments(starts_at)";

/** One list item per fee task: "Late cancellation fee for 6 Jan 2031 - Jane Smith" with the link that opens the invoice form for that task. Rows without a usable link are left out. */
export function feeTaskItems(rows: FeeTaskRow[], names?: Map<string, string>): FeeTaskItem[] {
  const out: FeeTaskItem[] = [];
  for (const r of rows) {
    const link = r.source === "late_cancel_fee" ? taskLink({ id: r.id, source: r.source, patient_id: r.patient_id, appointment_id: r.appointment_id }) : null;
    if (!link) continue;
    const a = Array.isArray(r.appointments) ? r.appointments[0] : r.appointments;
    const who = r.patient_id ? names?.get(r.patient_id) : undefined;
    out.push({ id: r.id, href: link.href, text: `Late cancellation fee${a ? ` for ${sastDayShort(sastDate(a.starts_at), true)}` : ""}${who ? `, ${who}` : ""}` });
  }
  return out;
}

/**
 * When a create-invoice call fails because the appointment already has a live invoice (a second click, a second tab) or because its fee task
 * is no longer open (the same double submit in task mode), the right answer is "here is the invoice", not an error.
 */
export const shouldShowExistingInvoice = (code: string, hasAppointment: boolean): boolean =>
  hasAppointment && (code === "appointment_has_invoice" || code === "task_not_open");
