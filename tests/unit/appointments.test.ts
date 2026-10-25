import { describe, it, expect } from "vitest";
import { apptErrorCode, apptErrorText, staffErrorText, APPT_ERROR } from "@/lib/appointments/errors";
import { noticeText } from "@/lib/appointments/notices";
import { portalMayChange, guardianMayBook, freeCancelUntil } from "@/lib/appointments/rules";
import { eventText, cancelReasonText } from "@/lib/appointments/events";
import { declineSchema, staffCancelSchema, overrideTimeSchema, createSchema } from "@/lib/appointments/input";
import { cancellationOutcome } from "@/lib/booking/policy";

describe("error mapping", () => {
  it.each([
    ["already_started", "started"], ["not_cancellable", "state"], ["not_reschedulable", "state"], ["forbidden", "forbidden"],
    ["unknown_appointment", "missing"], ["slot_taken", "taken"], ["start_in_past", "unavailable"], ["outside_hours", "unavailable"],
    ["blocked_time", "unavailable"], ["beyond_horizon", "unavailable"], ["invalid_appointment_transition", "state"], ["appointment_times_frozen", "state"], ["appointment_link_frozen", "state"],
    ["error: slot_taken (P0001)", "taken"], ["permission denied for table x", "generic"], ["", "generic"],
  ])("%s -> %s", (msg, code) => expect(apptErrorCode(msg)).toBe(code));
  it("null and undefined are generic, and no raw database text reaches the user", () => {
    expect(apptErrorText(null)).toBe(APPT_ERROR.generic); expect(apptErrorText(undefined)).toBe(APPT_ERROR.generic);
    expect(apptErrorText("relation appointments column foo")).not.toMatch(/relation|column/);
  });
  it("staff get the true reason for an overlap, patients the friendlier text", () => {
    expect(apptErrorText("slot_taken")).toMatch(/just taken/);
    expect(staffErrorText("slot_taken")).toMatch(/overlaps another appointment/);
    expect(staffErrorText("forbidden")).toBe(APPT_ERROR.forbidden);
  });
});

describe("notices", () => {
  it("only known codes render, including no prototype keys", () => {
    expect(noticeText("cancelled")).toMatch(/cancelled/);
    expect(noticeText("nope")).toBeUndefined(); expect(noticeText("__proto__")).toBeUndefined(); expect(noticeText("toString")).toBeUndefined(); expect(noticeText(undefined)).toBeUndefined();
  });
});

describe("what the portal offers", () => {
  const now = new Date("2031-01-06T10:00:00Z");
  it("buttons only for upcoming requested/tentative/confirmed appointments", () => {
    const future = new Date("2031-01-07T10:00:00Z");
    for (const status of ["requested", "tentative", "confirmed"]) expect(portalMayChange({ status, startsAt: future }, now)).toBe(true);
    for (const status of ["attended", "no_show", "cancelled"]) expect(portalMayChange({ status, startsAt: future }, now)).toBe(false);
    expect(portalMayChange({ status: "confirmed", startsAt: now }, now)).toBe(false);          // starting right now: already started
    expect(portalMayChange({ status: "confirmed", startsAt: new Date("2031-01-06T09:00:00Z") }, now)).toBe(false);
  });
  it("guardian needs permissions.book and a current guardianship", () => {
    const g = (permissions: unknown, valid_from = "2030-01-01", valid_to: string | null = null) => ({ permissions, valid_from, valid_to });
    expect(guardianMayBook(g({ book: true }), "2031-01-06")).toBe(true);
    expect(guardianMayBook(g({ book: "true" }), "2031-01-06")).toBe(true);
    expect(guardianMayBook(g({ book: false }), "2031-01-06")).toBe(false);
    expect(guardianMayBook(g({}), "2031-01-06")).toBe(false);
    expect(guardianMayBook(g(null), "2031-01-06")).toBe(false);
    expect(guardianMayBook(g({ book: true }, "2031-02-01"), "2031-01-06")).toBe(false);          // not started
    expect(guardianMayBook(g({ book: true }, "2030-01-01", "2031-01-05"), "2031-01-06")).toBe(false); // ended
    expect(guardianMayBook(g({ book: true }, "2030-01-01", "2031-01-06"), "2031-01-06")).toBe(true);  // last day counts
  });
  it("policy outcome around the window edge", () => {
    const startsAt = new Date("2031-01-07T10:00:00Z");
    const o = (nowIso: string) => cancellationOutcome({ startsAt, now: new Date(nowIso), windowHours: 24, lateFeeCents: 35000 });
    expect(o("2031-01-06T09:59:00Z")).toMatchObject({ late: false, feeCents: 0 });
    expect(o("2031-01-06T10:01:00Z")).toMatchObject({ late: true, feeCents: 35000 });
    expect(freeCancelUntil(startsAt, 24).toISOString()).toBe("2031-01-06T10:00:00.000Z");
  });
});

describe("event history wording", () => {
  it("reads like a sentence", () => {
    expect(eventText({ event: "created", detail: { status: "tentative" } })).toBe("Booked as Requested");
    expect(eventText({ event: "created", detail: { status: "confirmed", rescheduled_from: "x" } })).toBe("Booked as Confirmed (moved from an earlier appointment)");
    expect(eventText({ event: "status:no_show", detail: null })).toBe("Marked no-show");
    expect(eventText({ event: "status:cancelled", detail: null })).toBe("Cancelled");
    expect(eventText({ event: "rescheduled", detail: { from: "2031-01-06T07:00:00Z", to: "2031-01-07T07:30:00Z" } })).toBe("Moved from Monday, 6 January 2031 at 09:00 to Tuesday, 7 January 2031 at 09:30");
    expect(eventText({ event: "rescheduled", detail: null })).toContain("an earlier time");
    expect(eventText({ event: "weird_thing", detail: null })).toBe("weird thing");
  });
  it("cancel reasons", () => {
    expect(cancelReasonText(null)).toBeNull();
    expect(cancelReasonText("patient_cancelled")).toBe("Cancelled by the patient");
    expect(cancelReasonText("rescheduled")).toBe("Moved to another time");
    expect(cancelReasonText("Therapist unwell")).toBe("Therapist unwell");
  });
});

describe("form input", () => {
  it("decline needs a reason", () => {
    expect(declineSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(declineSchema.safeParse({}).success).toBe(false);
    expect(declineSchema.parse({ reason: " Fully booked " }).reason).toBe("Fully booked");
  });
  it("staff cancel: reason optional, checkbox 'on' means charge", () => {
    expect(staffCancelSchema.parse({ reason: "", chargeFee: "on" })).toEqual({ reason: undefined, chargeFee: true });
    expect(staffCancelSchema.parse({})).toEqual({ reason: undefined, chargeFee: false });
    expect(staffCancelSchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });
  it("override time becomes a SAST instant", () => {
    expect(overrideTimeSchema.parse({ date: "2031-01-06", time: "07:30" })).toBe("2031-01-06T05:30:00.000Z");
    expect(overrideTimeSchema.safeParse({ date: "2031-02-30", time: "07:30" }).success).toBe(false);
    expect(overrideTimeSchema.safeParse({ date: "2031-01-06", time: "7:30" }).success).toBe(false);
  });
  it("create validates ids, status and clock", () => {
    const ok = { patientId: "6f1c1c1e-1b0c-4a52-9a52-2f4e7a3d9c10", typeId: "0b9c1c1e-1b0c-4a52-9a52-2f4e7a3d9c11", date: "2031-01-06", time: "09:00", status: "tentative" };
    expect(createSchema.safeParse(ok).success).toBe(true);
    expect(createSchema.safeParse({ ...ok, status: "attended" }).success).toBe(false);
    expect(createSchema.safeParse({ ...ok, patientId: "nope" }).success).toBe(false);
  });
});

describe("cancellation window and reschedule", () => {
  it("matches the database rule at the edge", async () => {
    const { insideCancellationWindow } = await import("@/lib/appointments/rules");
    const startsAt = new Date("2031-01-07T10:00:00Z");
    expect(insideCancellationWindow(startsAt, new Date("2031-01-06T10:00:00Z"), 24)).toBe(false); // exactly 24h: outside
    expect(insideCancellationWindow(startsAt, new Date("2031-01-06T10:00:01Z"), 24)).toBe(true);
    expect(insideCancellationWindow(startsAt, new Date("2031-01-07T09:59:00Z"), 0)).toBe(false);  // window 0: never inside while upcoming
  });
  it("maps inside_cancellation_window to its own plain-language message", () => {
    expect(apptErrorCode("inside_cancellation_window")).toBe("window");
    expect(apptErrorText("error: inside_cancellation_window")).toMatch(/cancel it.*contact the practice/);
    expect(staffErrorText("inside_cancellation_window")).toBe(APPT_ERROR.window);
  });
});
