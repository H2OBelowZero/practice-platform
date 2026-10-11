"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { APPT_ERROR, staffErrorText } from "@/lib/appointments/errors";
import { createLateFeeTask, patientEmail, queueApptEmail, safely } from "@/lib/appointments/followups";
import { apptId, createSchema, declineSchema, isoInstant, overrideTimeSchema, staffCancelSchema } from "@/lib/appointments/input";
import type { NoticeCode } from "@/lib/appointments/notices";
import { isActiveStatus } from "@/lib/appointments/rules";
import type { ActionState, Values } from "@/lib/appointments/types";
import { supabaseServer } from "@/lib/supabase/server";
import { sastInstant } from "@/lib/time";

// Staff calendar actions. Every one calls requireRole itself (R26), validates with Zod, lets the database decide (RLS, the
// 0009 status machine, cancel/reschedule/book functions), then audits and queues the patient's email. Follow-ups never undo a change.
const STAFF = ["psychologist", "admin"] as const;

type Appt = { id: string; patient_id: string; session_type_id: string; starts_at: string; status: string };

async function load(rawId: unknown) {
  await requireRole([...STAFF]);
  const id = apptId.safeParse(rawId);
  if (!id.success) return null;
  const sb = await supabaseServer();
  const { data } = await sb.from("appointments").select("id, patient_id, session_type_id, starts_at, status").eq("id", id.data).maybeSingle();
  return { id: id.data, sb, appt: (data as Appt | null) ?? null };
}
const done = (id: string, notice: NoticeCode): never => redirect(`/app/calendar/${id}?notice=${notice}`);
const firstIssue = (e: { issues: { message: string }[] }) => e.issues[0]?.message ?? APPT_ERROR.invalid;

/** Status change by UPDATE (staff RLS). The WHERE repeats the status we read, so two staff members clicking at once cannot both win. */
async function changeStatus(rawId: unknown, spec: { from: string[]; to: "confirmed" | "attended" | "no_show"; audit: string; notice: NoticeCode; needsStarted?: boolean; email?: "booking_confirmed" }): Promise<ActionState> {
  const ctx = await load(rawId);
  if (!ctx) return { error: APPT_ERROR.invalid };
  const { id, sb, appt } = ctx;
  if (!appt) return { error: APPT_ERROR.missing };
  if (!spec.from.includes(appt.status)) return { error: APPT_ERROR.state };
  if (spec.needsStarted && new Date(appt.starts_at) > new Date()) return { error: "This can be recorded once the appointment has started." };

  const { data, error } = await sb.from("appointments").update({ status: spec.to }).eq("id", id).eq("status", appt.status).select("id");
  if (error) return { error: staffErrorText(error.message) };
  if (!data?.length) return { error: APPT_ERROR.state };

  await safely(spec.audit, () => audit(spec.audit, "appointments", id, { from: appt.status, to: spec.to }));
  if (spec.email) await queueApptEmail(spec.email, await patientEmail(sb, appt.patient_id), appt.starts_at);
  return done(id, spec.notice);
}

export async function confirmAppointment(id: unknown): Promise<ActionState> {
  return changeStatus(id, { from: ["tentative", "requested"], to: "confirmed", audit: "appointment.confirm", notice: "confirmed", email: "booking_confirmed" });
}
export async function markAttended(id: unknown): Promise<ActionState> {
  return changeStatus(id, { from: ["confirmed"], to: "attended", audit: "appointment.attend", notice: "attended", needsStarted: true });
}
export async function markNoShow(id: unknown): Promise<ActionState> {
  return changeStatus(id, { from: ["confirmed"], to: "no_show", audit: "appointment.no_show", notice: "no_show", needsStarted: true });
}

/** Cancel through cancel_appointment (sets cancelled_by and the reason). Shared by decline and staff cancel. */
async function cancelAsStaff(rawId: unknown, reasonText: string, o: { from: string[]; audit: string; notice: NoticeCode; chargeFee: boolean }): Promise<ActionState> {
  const ctx = await load(rawId);
  if (!ctx) return { error: APPT_ERROR.invalid };
  const { id, sb, appt } = ctx;
  if (!appt) return { error: APPT_ERROR.missing };
  if (!o.from.includes(appt.status)) return { error: APPT_ERROR.state };

  const { error } = await sb.rpc("cancel_appointment", { p_appt: id, p_reason: reasonText });
  if (error) return { error: staffErrorText(error.message) };

  if (o.chargeFee) await createLateFeeTask(appt.patient_id, id); // R29: a task, never an invoice
  await safely(o.audit, () => audit(o.audit, "appointments", id, { from: appt.status, chargeFee: o.chargeFee }));
  await queueApptEmail("appointment_cancelled", await patientEmail(sb, appt.patient_id), appt.starts_at);
  return done(id, o.notice);
}

/** Decline a request: a reason is required (it is stored with the appointment and the patient may see it). */
export async function declineAppointment(id: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const v = declineSchema.safeParse(values);
  if (!v.success) return { error: firstIssue(v.error) };
  return cancelAsStaff(id, `Declined: ${v.data.reason}`, { from: ["tentative", "requested"], audit: "appointment.decline", notice: "declined", chargeFee: false });
}

/** Cancel a confirmed (or requested) appointment. No late-fee task unless staff tick "Charge late cancellation fee". */
export async function cancelAppointmentStaff(id: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const v = staffCancelSchema.safeParse(values);
  if (!v.success) return { error: firstIssue(v.error) };
  return cancelAsStaff(id, v.data.reason || "staff_cancelled", { from: ["requested", "tentative", "confirmed"], audit: "appointment.cancel_staff", notice: "cancelled_staff", chargeFee: v.data.chargeFee });
}

/** Staff move: no availability rules apply (the database exempts staff); only overlaps are refused. */
async function moveAsStaff(rawId: unknown, startIso: string): Promise<ActionState> {
  const ctx = await load(rawId);
  if (!ctx) return { error: APPT_ERROR.invalid };
  const { id, sb, appt } = ctx;
  if (!appt) return { error: APPT_ERROR.missing };
  if (!isActiveStatus(appt.status)) return { error: APPT_ERROR.state };

  const moved = await sb.rpc("reschedule_appointment", { p_appt: id, p_new_start: startIso });
  if (moved.error || !moved.data) return { error: staffErrorText(moved.error?.message) };
  const newId = moved.data as string;

  await safely("appointment.reschedule_staff", () => audit("appointment.reschedule_staff", "appointments", newId, { from: appt.starts_at, to: startIso, previous_id: id }));
  await queueApptEmail("appointment_rescheduled", await patientEmail(sb, appt.patient_id), startIso);
  return done(newId, "rescheduled_staff");
}

/** Move to a time chosen from the slot buttons. */
export async function rescheduleAppointmentStaff(id: unknown, newStartIso: unknown): Promise<ActionState> {
  await requireRole([...STAFF]);
  const start = isoInstant.safeParse(newStartIso);
  if (!start.success) return { error: APPT_ERROR.invalid };
  return moveAsStaff(id, start.data);
}

/** Move to any date and time (override hours), given as SAST wall-clock values from the form. */
export async function rescheduleAppointmentStaffAt(id: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const v = overrideTimeSchema.safeParse(values);
  if (!v.success) return { error: firstIssue(v.error) };
  return moveAsStaff(id, v.data);
}

/** Book an appointment for a patient as staff: any time, confirmed or tentative. Overlaps are refused by the database. */
export async function createAppointment(values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const v = createSchema.safeParse(values);
  if (!v.success) return { error: firstIssue(v.error) };
  const startIso = sastInstant(v.data.date, v.data.time);
  if (!startIso) return { error: APPT_ERROR.invalid };

  const sb = await supabaseServer();
  const booked = await sb.rpc("book_appointment", { p_patient: v.data.patientId, p_type: v.data.typeId, p_start: startIso, p_status: v.data.status });
  if (booked.error || !booked.data) return { error: staffErrorText(booked.error?.message) };
  const id = booked.data as string;

  await safely("appointment.create_staff", () => audit("appointment.create_staff", "appointments", id, { status: v.data.status }));
  await queueApptEmail(v.data.status === "confirmed" ? "booking_confirmed" : "booking_requested", await patientEmail(sb, v.data.patientId), startIso);
  return done(id, "created");
}
