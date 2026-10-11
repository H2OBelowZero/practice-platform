import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/app-url";
import { supabaseService } from "@/lib/supabase/service";
import { sastDateLabel, sastTime } from "@/lib/time";

export type ApptTemplate = "booking_confirmed" | "booking_requested" | "appointment_cancelled" | "appointment_rescheduled";

/**
 * Queue a short email for the notification worker. The payload is the date, the time and a link only (no names, no clinical detail).
 * Written with the service client (the outbox is service-role only). Never throws: the appointment change has already happened,
 * so a failure here is logged (code only) and must not make the user think it failed.
 */
export async function queueApptEmail(template: ApptTemplate, recipient: string | null | undefined, startIso: string): Promise<void> {
  if (!recipient) return;
  try {
    const { error } = await supabaseService().from("notifications_outbox").insert({
      channel: "email", template, recipient,
      payload: { date: sastDateLabel(startIso), time: sastTime(startIso), link: `${appUrl()}/portal/appointments` },
    });
    if (error) console.error(`${template} not queued:`, error.code);
  } catch (e) { console.error(`${template} not queued:`, e instanceof Error ? e.message : "unknown"); }
}

/** The patient's email for a staff-initiated notice, unless they turned email off. Read with the staff user's own (RLS) client. */
export async function patientEmail(sb: SupabaseClient, patientId: string): Promise<string | null> {
  const { data } = await sb.from("patients").select("email, comms_prefs").eq("id", patientId).maybeSingle();
  const prefs = data?.comms_prefs as { email?: boolean } | null | undefined;
  return data?.email && prefs?.email !== false ? (data.email as string) : null;
}

/** R29: a late cancellation never creates an invoice here; it creates a staff task, which Task 13 turns into a draft invoice. */
export async function createLateFeeTask(patientId: string, appointmentId: string): Promise<void> {
  try {
    const { error } = await supabaseService().from("tasks").insert({
      title: "Late cancellation: review fee", priority: "high", source: "late_cancel_fee", patient_id: patientId, appointment_id: appointmentId,
    });
    if (error) console.error("late fee task not created:", error.code);
  } catch (e) { console.error("late fee task not created:", e instanceof Error ? e.message : "unknown"); }
}

/** Run a follow-up step (audit, ...) whose failure must not undo a change that has already been made. */
export async function safely(label: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (e) { console.error(`${label} failed:`, e instanceof Error ? e.message : "unknown"); }
}
