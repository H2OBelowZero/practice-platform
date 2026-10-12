"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { appUrl } from "@/lib/app-url";
import { requireRole } from "@/lib/auth/session";
import { getSlots } from "@/lib/booking/availability";
import { BOOKING_ERROR_TEXT, RETRY_WITH_SLOTS, bookingErrorCode, type BookingErrorCode } from "@/lib/booking/errors";
import { bookingInputSchema, startInBookingWindow } from "@/lib/booking/input";
import { getPractice } from "@/lib/practice";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { sastDate, sastDateLabel, sastTime } from "@/lib/time";

export type BookState = { error: string } | null;

const backToSlots = (typeId: string, startIso: string, code: BookingErrorCode) =>
  `/book?type=${encodeURIComponent(typeId)}&date=${sastDate(startIso)}&e=${code}`;

/**
 * Book the signed-in patient into a slot. The database decides the status (R19: auto -> confirmed, request -> tentative),
 * enforces hours, blocked time, the 5-booking cap and slot uniqueness; this action adds validation, the terms consent and the
 * confirmation message. Guardians book from the portal in a later step.
 */
export async function bookAppointment(input: unknown): Promise<BookState> {
  const parsed = bookingInputSchema.safeParse(input);
  if (!parsed.success) {
    const termsMissing = parsed.error.issues.some((i) => i.path[0] === "acceptedTerms");
    return { error: termsMissing ? "Please tick the box to accept the booking and cancellation terms." : BOOKING_ERROR_TEXT.generic };
  }
  const { typeId, startIso } = parsed.data;

  const me = await requireRole(["patient", "guardian"]); // staff get a 404; anonymous users go to /login
  if (me.role === "guardian") {
    return { error: "Guardians will be able to book for the person they care for from the portal in a later step. For now, please contact the practice." };
  }
  if (!startInBookingWindow(startIso, new Date())) return { error: BOOKING_ERROR_TEXT.unavailable };

  // App-level checks the database does not make: the time must be one of the offered slots (grid alignment and buffers).
  let slots: string[];
  try { slots = await getSlots(typeId, sastDate(startIso)); } catch { return { error: BOOKING_ERROR_TEXT.generic }; }
  if (!slots.includes(startIso)) redirect(backToSlots(typeId, startIso, "taken"));

  const sb = await supabaseServer();
  const patient = await sb.rpc("ensure_patient_record");
  if (patient.error || !patient.data) return { error: BOOKING_ERROR_TEXT.generic };
  const patientId = patient.data as string;

  // The checkbox is the financial-terms acceptance: recorded separately, as its own consent purpose. accept_booking_terms (0012) is the booking flow's
  // own door: the general consent function refuses a patient's grant that no submitted form backs, and this function can record financial_terms and nothing else.
  const consent = await sb.rpc("accept_booking_terms", { p_patient: patientId });
  if (consent.error) return { error: BOOKING_ERROR_TEXT.generic };

  const booked = await sb.rpc("book_appointment", { p_patient: patientId, p_type: typeId, p_start: startIso }); // status is derived by the DB
  if (booked.error || !booked.data) {
    const code = bookingErrorCode(booked.error?.message);
    if (RETRY_WITH_SLOTS.includes(code)) redirect(backToSlots(typeId, startIso, code));
    if (code === "type") redirect("/book?e=type");
    return { error: BOOKING_ERROR_TEXT[code] };
  }
  const apptId = booked.data as string;

  // From here the booking exists: a failure below is logged but must not make the patient think it failed.
  try {
    const { data: row } = await sb.from("appointments").select("status").eq("id", apptId).maybeSingle();
    const status = (row?.status as string | undefined) ?? "tentative";
    const { data: { user } } = await sb.auth.getUser();
    if (user?.email) {
      const { error } = await supabaseService().from("notifications_outbox").insert({
        channel: "email",
        template: status === "confirmed" ? "booking_confirmed" : "booking_requested",
        recipient: user.email,
        payload: { date: sastDateLabel(startIso), time: sastTime(startIso), link: `${appUrl()}/portal/appointments` }, // no clinical or identity detail
      });
      if (error) console.error("booking notification not queued:", error.code);
    }
    // the terms the patient accepted (checkbox -> financial_terms consent) are the practice settings in force right now
    const practice = await getPractice();
    await audit("booking.create", "appointments", apptId, {
      status,
      terms_accepted: { cancellation_window_hours: practice?.cancellation_window_hours ?? null, late_cancel_fee_cents: practice?.late_cancel_fee_cents ?? null },
    });
  } catch (e) {
    console.error("booking follow-up failed:", e instanceof Error ? e.message : "unknown");
  }
  redirect(`/book/confirmed?id=${apptId}`);
}
