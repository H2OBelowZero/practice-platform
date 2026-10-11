import { BOOKING_ERROR_TEXT } from "@/lib/booking/errors";

// Database errors from cancel_appointment / reschedule_appointment / book_appointment / the status machine (0002, 0008, 0009)
// to plain-language wording. Anything unrecognised becomes the generic text: never leak internals.
export const APPT_ERROR = {
  started: "This appointment has already started, so it can no longer be changed online. Please contact the practice.",
  state: "This appointment can no longer be changed. It may already have been cancelled or completed.",
  window: "This appointment is inside the cancellation window, so it cannot be moved online. You can cancel it (a late fee may apply) or contact the practice.",
  forbidden: "You do not have permission to change this appointment. Please contact the practice.",
  missing: "We could not find that appointment.",
  taken: BOOKING_ERROR_TEXT.taken,
  unavailable: BOOKING_ERROR_TEXT.unavailable,
  invalid: "Please check the details and try again.",
  generic: "Something went wrong and nothing was changed. Please try again, or contact the practice.",
} as const;
export type ApptErrorCode = keyof typeof APPT_ERROR;

export function apptErrorCode(message: string | undefined | null): ApptErrorCode {
  const m = message ?? "";
  if (m.includes("already_started")) return "started";
  if (m.includes("not_cancellable") || m.includes("not_reschedulable") || m.includes("invalid_appointment_transition") || m.includes("appointment_times_frozen")) return "state";
  if (m.includes("inside_cancellation_window")) return "window";
  if (m.includes("forbidden")) return "forbidden";
  if (m.includes("unknown_appointment")) return "missing";
  if (m.includes("slot_taken")) return "taken";
  if (m.includes("start_in_past") || m.includes("outside_hours") || m.includes("blocked_time") || m.includes("beyond_horizon")) return "unavailable";
  if (m.includes("invalid_status") || m.includes("unknown_session_type")) return "invalid";
  return "generic";
}
export const apptErrorText = (message: string | undefined | null): string => APPT_ERROR[apptErrorCode(message)];

/** Staff see the true reason for an overlap; patients get the friendlier "just taken". */
export const STAFF_ERROR_OVERRIDE: Partial<Record<ApptErrorCode, string>> = {
  taken: "That time overlaps another appointment. Choose a different time.",
  unavailable: "That time is not available.",
};
export const staffErrorText = (message: string | undefined | null): string => {
  const code = apptErrorCode(message);
  return STAFF_ERROR_OVERRIDE[code] ?? APPT_ERROR[code];
};
