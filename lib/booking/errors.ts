// Maps database / action failures to patient-facing wording. The DB raises plain codes (see 0002 and 0008 migrations).
export type BookingErrorCode = "taken" | "unavailable" | "limit" | "type" | "generic";

export const BOOKING_ERROR_TEXT: Record<BookingErrorCode, string> = {
  taken: "That time was just taken. Please choose another.",
  unavailable: "That time is not available.",
  limit: "You already have the maximum of 5 upcoming appointments. Please cancel or attend one before booking another.",
  type: "That session type is no longer available. Please choose another.",
  generic: "We could not complete this booking. Please try again, or contact the practice.",
};

/** Codes after which the patient should pick another time (the page re-renders fresh slots). */
export const RETRY_WITH_SLOTS: BookingErrorCode[] = ["taken", "unavailable"];

export function bookingErrorCode(message: string | undefined | null): BookingErrorCode {
  const m = message ?? "";
  if (m.includes("slot_taken")) return "taken";
  if (m.includes("start_in_past") || m.includes("outside_hours") || m.includes("blocked_time") || m.includes("beyond_horizon")) return "unavailable";
  if (m.includes("too_many_bookings")) return "limit";
  if (m.includes("unknown_session_type")) return "type";
  return "generic"; // includes 'forbidden' and anything unexpected: never leak internals
}

// Object.hasOwn, not `in`: ?e=__proto__ / toString / constructor must not count as codes (they live on the prototype chain).
export const isBookingErrorCode = (s: string | undefined): s is BookingErrorCode => typeof s === "string" && Object.hasOwn(BOOKING_ERROR_TEXT, s);
