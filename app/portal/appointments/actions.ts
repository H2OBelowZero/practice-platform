"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { APPT_ERROR, apptErrorCode, apptErrorText } from "@/lib/appointments/errors";
import { queueApptEmail, safely } from "@/lib/appointments/followups";
import { apptId, isoInstant } from "@/lib/appointments/input";
import { isActiveStatus } from "@/lib/appointments/rules";
import type { ActionState } from "@/lib/appointments/types";
import { getSlots } from "@/lib/booking/availability";
import { startInBookingWindow } from "@/lib/booking/input";
import { cancellationOutcome } from "@/lib/booking/policy";
import { getPractice } from "@/lib/practice";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";

type Row = { id: string; patient_id: string; session_type_id: string; starts_at: string; status: string };

/** The appointment as the signed-in user's own RLS client sees it: someone else's appointment simply is not there. */
async function loadOwn(id: string) {
  const sb = await supabaseServer();
  const { data } = await sb.from("appointments").select("id, patient_id, session_type_id, starts_at, status").eq("id", id).maybeSingle();
  return { sb, appt: (data as Row | null) ?? null };
}

/**
 * Cancel an appointment (patient or guardian). The database (cancel_appointment, 0010) decides whether the cancel is allowed
 * (ownership, guardian permission, not started, still active) and, in the same transaction, creates the late-fee task and the audit row.
 * The policy outcome is computed here only to choose the confirmation message (R29: a late cancel is a staff task, never an invoice).
 */
export async function cancelAppointment(id: unknown): Promise<ActionState> {
  await requireRole(["patient", "guardian"]);
  const parsed = apptId.safeParse(id);
  if (!parsed.success) return { error: APPT_ERROR.invalid };

  const { sb, appt } = await loadOwn(parsed.data);
  if (!appt) return { error: APPT_ERROR.missing };

  const practice = await getPractice();
  const outcome = cancellationOutcome({
    startsAt: new Date(appt.starts_at), now: new Date(),
    windowHours: practice?.cancellation_window_hours ?? 24, lateFeeCents: practice?.late_cancel_fee_cents ?? 0,
  });

  const { error } = await sb.rpc("cancel_appointment", { p_appt: appt.id, p_reason: "patient_cancelled" });
  if (error) return { error: apptErrorText(error.message) };

  // The cancellation (task and audit included) is committed. The email must not make it look as if it failed.
  await safely("cancel notification", async () => {
    const { data: { user } } = await sb.auth.getUser();
    await queueApptEmail("appointment_cancelled", user?.email, appt.starts_at);
  });
  redirect(`/portal/appointments?notice=${outcome.feeCents > 0 ? "cancelled_late" : "cancelled"}`);
}

const backToPicker = (id: string, startIso: string, code: "taken" | "unavailable") =>
  `/portal/appointments/${id}/reschedule?date=${sastDate(startIso)}&e=${code}`;

/**
 * Move an appointment to another offered time (patient or guardian). The new time must be one of the slots getSlots offers
 * (grid and buffers), then reschedule_appointment makes the change atomically: any failure leaves the original untouched.
 */
export async function rescheduleAppointment(id: unknown, newStartIso: unknown): Promise<ActionState> {
  await requireRole(["patient", "guardian"]);
  const parsedId = apptId.safeParse(id), parsedStart = isoInstant.safeParse(newStartIso);
  if (!parsedId.success || !parsedStart.success) return { error: APPT_ERROR.invalid };
  const startIso = parsedStart.data;

  const { sb, appt } = await loadOwn(parsedId.data);
  if (!appt) return { error: APPT_ERROR.missing };
  if (!isActiveStatus(appt.status)) return { error: APPT_ERROR.state };
  if (!startInBookingWindow(startIso, new Date())) return { error: APPT_ERROR.unavailable };

  let slots: string[];
  try { slots = await getSlots(appt.session_type_id, sastDate(startIso), { includeInactive: true }); } catch { return { error: APPT_ERROR.generic }; }
  if (!slots.includes(startIso)) redirect(backToPicker(appt.id, startIso, "taken"));

  const moved = await sb.rpc("reschedule_appointment", { p_appt: appt.id, p_new_start: startIso });
  if (moved.error || !moved.data) {
    const code = apptErrorCode(moved.error?.message);
    if (code === "taken" || code === "unavailable") redirect(backToPicker(appt.id, startIso, code));
    return { error: APPT_ERROR[code] };
  }
  const newId = moved.data as string;

  await safely("reschedule notification", async () => {
    const { data: { user } } = await sb.auth.getUser();
    await queueApptEmail("appointment_rescheduled", user?.email, startIso);
  });
  await safely("reschedule audit", () => audit("appointment.reschedule", "appointments", newId, { from: appt.starts_at, to: startIso, previous_id: appt.id }));
  redirect("/portal/appointments?notice=rescheduled");
}
