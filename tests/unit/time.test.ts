import { it, expect } from "vitest";
import { addDays, bookingDateRange, dayWindowUtc, isBookableDate, isRealDate, sastDate, sastDateLabel, sastTime } from "@/lib/time";

it("formats instants in SAST (UTC+2)", () => {
  expect(sastTime("2031-01-06T06:00:00.000Z")).toBe("08:00");
  expect(sastTime("2031-01-06T22:30:00.000Z")).toBe("00:30"); // past SAST midnight
  expect(sastDate("2031-01-06T22:30:00.000Z")).toBe("2031-01-07");
  expect(sastDate("2031-01-06T21:59:59.999Z")).toBe("2031-01-06");
  expect(sastDateLabel("2031-01-06T08:00:00.000Z")).toBe("Monday, 6 January 2031");
  expect(sastDateLabel("2031-01-06")).toBe("Monday, 6 January 2031");
});

it("adds days across month and year ends", () => {
  expect(addDays("2030-12-31", 1)).toBe("2031-01-01");
  expect(addDays("2032-02-28", 1)).toBe("2032-02-29");
  expect(addDays("2031-03-01", -1)).toBe("2031-02-28");
});

it("booking window runs from tomorrow to 60 days ahead, by the SAST calendar day", () => {
  // 22:30Z on 31 Dec is already 1 January in South Africa
  expect(bookingDateRange(new Date("2030-12-31T22:30:00Z"))).toEqual({ min: "2031-01-02", max: "2031-03-02" });
  expect(bookingDateRange(new Date("2030-12-31T12:00:00Z"))).toEqual({ min: "2031-01-01", max: "2031-03-01" });
});

it("isBookableDate enforces tomorrow..+60 days and real dates", () => {
  const now = new Date("2030-06-10T10:00:00Z"); // today (SAST) = 2030-06-10
  expect(isBookableDate("2030-06-10", now)).toBe(false); // today
  expect(isBookableDate("2030-06-11", now)).toBe(true);  // tomorrow
  expect(isBookableDate("2030-08-09", now)).toBe(true);  // +60
  expect(isBookableDate("2030-08-10", now)).toBe(false); // +61
  expect(isBookableDate("2030-02-30", now)).toBe(false);
  expect(isBookableDate("banana", now)).toBe(false);
  expect(isBookableDate("2030-6-11", now)).toBe(false);
});

it("isRealDate rejects impossible dates", () => {
  expect(isRealDate("2032-02-29")).toBe(true);
  expect(isRealDate("2031-02-29")).toBe(false);
  expect(isRealDate("2031-13-01")).toBe(false);
});

it("dayWindowUtc covers the SAST day plus a day either side (under busy_ranges' 62-day limit)", () => {
  const w = dayWindowUtc("2031-01-06"); // SAST midnight = 2031-01-05T22:00Z
  expect(w).toEqual({ from: "2031-01-04T22:00:00.000Z", to: "2031-01-07T22:00:00.000Z" });
});
