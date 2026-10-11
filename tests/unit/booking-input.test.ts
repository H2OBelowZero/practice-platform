import { it, expect } from "vitest";
import { BOOKING_ERROR_TEXT, bookingErrorCode, isBookingErrorCode } from "@/lib/booking/errors";
import { bookingInputSchema, bookingUrl, parseBookParams, slotQuerySchema, startInBookingWindow } from "@/lib/booking/input";
import { safeNext } from "@/lib/auth/redirect";

const T = "5a4e3b2c-1d0f-4a9b-8c7d-6e5f4a3b2c1d";
const START = "2031-01-06T06:00:00.000Z";

it.each([
  ["slot_taken", "taken"], ["error: slot_taken", "taken"],
  ["start_in_past", "unavailable"], ["outside_hours", "unavailable"], ["blocked_time", "unavailable"],
  ["too_many_bookings", "limit"], ["unknown_session_type", "type"],
  ["forbidden", "generic"], ["anything else", "generic"], ["", "generic"], [undefined, "generic"], [null, "generic"],
] as const)("maps database message %j to %s", (msg, code) => expect(bookingErrorCode(msg)).toBe(code));

it("wording: taken says 'just taken', unavailable says 'not available', limit mentions the cap", () => {
  expect(BOOKING_ERROR_TEXT.taken).toBe("That time was just taken. Please choose another.");
  expect(BOOKING_ERROR_TEXT.unavailable).toBe("That time is not available.");
  expect(BOOKING_ERROR_TEXT.limit).toMatch(/maximum of 5/);
  expect(isBookingErrorCode("taken")).toBe(true);
  expect(isBookingErrorCode("<script>")).toBe(false);
  expect(isBookingErrorCode(undefined)).toBe(false);
});

it("booking input needs a uuid, a canonical ISO instant and acceptedTerms === true", () => {
  const ok = { typeId: T, startIso: START, acceptedTerms: true };
  expect(bookingInputSchema.safeParse(ok).success).toBe(true);
  for (const bad of [
    { ...ok, acceptedTerms: false }, { ...ok, acceptedTerms: "on" }, { typeId: T, startIso: START },
    { ...ok, typeId: "nope" }, { ...ok, startIso: "2031-01-06" }, { ...ok, startIso: "2031-01-06T06:00:00Z" }, // not canonical (no ms)
    { ...ok, startIso: "2031-01-06T08:00:00.000+02:00" }, null, "x",
  ]) expect(bookingInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
});

it("slot query validates uuid and real date", () => {
  expect(slotQuerySchema.safeParse({ typeId: T, date: "2031-01-06" }).success).toBe(true);
  expect(slotQuerySchema.safeParse({ typeId: T, date: "2031-02-30" }).success).toBe(false);
  expect(slotQuerySchema.safeParse({ typeId: "x", date: "2031-01-06" }).success).toBe(false);
});

it("parseBookParams drops malformed params instead of throwing", () => {
  expect(parseBookParams({ type: T, date: "2031-01-06", start: START })).toEqual({ typeId: T, date: "2031-01-06", startIso: START });
  expect(parseBookParams({ type: "x", date: "bad", start: "bad" })).toEqual({ typeId: undefined, date: undefined, startIso: undefined });
  expect(parseBookParams({})).toEqual({ typeId: undefined, date: undefined, startIso: undefined });
});

it("startInBookingWindow uses the SAST day", () => {
  const now = new Date("2031-01-01T10:00:00Z");
  expect(startInBookingWindow("2031-01-01T15:00:00.000Z", now)).toBe(false); // later today
  expect(startInBookingWindow("2031-01-02T06:00:00.000Z", now)).toBe(true);
  expect(startInBookingWindow("2031-03-02T06:00:00.000Z", now)).toBe(true);  // +60
  expect(startInBookingWindow("2031-03-03T06:00:00.000Z", now)).toBe(false); // +61
});

it("the resume URL carries type and start and survives the open-redirect guard used by /login and /register", () => {
  const url = bookingUrl(T, START);
  expect(url).toBe(`/book?type=${T}&date=2031-01-06&start=2031-01-06T06%3A00%3A00.000Z`);
  expect(safeNext(url, "/")).toBe(url);
  // and after one round of encodeURIComponent as used in ?next=
  expect(safeNext(decodeURIComponent(encodeURIComponent(url)), "/")).toBe(url);
  expect(parseBookParams(Object.fromEntries(new URL(url, "http://x").searchParams))).toMatchObject({ typeId: T, startIso: START });
});
