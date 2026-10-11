import { it, expect } from "vitest";
import { generateSlots } from "@/lib/booking/slots";

const rules = [{ weekday: 1, start: "08:00", end: "12:00" }]; // Monday
const base = { rules, durationMin: 50, bufferMin: 10, now: new Date("2030-01-01T00:00:00Z") };

it("builds slots in SAST on the right day", () => {
  const s = generateSlots({ ...base, date: "2030-01-07", busy: [] }); // 2030-01-07 is a Monday
  expect(s[0]).toBe("2030-01-07T06:00:00.000Z"); // 08:00 SAST
  expect(s).toHaveLength(4);
});

it("removes busy overlaps including buffer", () => {
  const s = generateSlots({ ...base, date: "2030-01-07", busy: [{ start: "2030-01-07T07:00:00Z", end: "2030-01-07T07:50:00Z" }] });
  expect(s).not.toContain("2030-01-07T07:00:00.000Z");
  expect(s).toContain("2030-01-07T06:00:00.000Z"); // ends 06:50; its buffer ends exactly when the busy range starts: valid
  expect(s).toContain("2030-01-07T08:00:00.000Z");
});

it("hides past slots and non-working days", () => {
  expect(generateSlots({ ...base, date: "2030-01-08", busy: [] })).toEqual([]);
  expect(generateSlots({ ...base, now: new Date("2030-01-07T07:30:00Z"), date: "2030-01-07", busy: [] }).every(x => x > "2030-01-07T07:30:00Z")).toBe(true);
});

it("uses the SAST calendar day, not the UTC day", () => {
  const s = generateSlots({ rules: [{ weekday: 1, start: "00:30", end: "02:30" }], durationMin: 50, bufferMin: 10, busy: [], date: "2030-01-07", now: new Date("2030-01-01T00:00:00Z") });
  expect(s).toEqual(["2030-01-06T22:30:00.000Z", "2030-01-06T23:30:00.000Z"]);
});

it("handles month and year boundaries", () => {
  const thu = { rules: [{ weekday: 4, start: "08:00", end: "10:00" }], durationMin: 50, bufferMin: 10, busy: [], now: new Date("2030-01-01T00:00:00Z") };
  expect(generateSlots({ ...thu, date: "2030-01-31" })[0]).toBe("2030-01-31T06:00:00.000Z");
  const mon = { ...thu, rules: [{ weekday: 1, start: "08:00", end: "10:00" }], now: new Date("2029-01-01T00:00:00Z") };
  expect(generateSlots({ ...mon, date: "2029-12-31" })[0]).toBe("2029-12-31T06:00:00.000Z");
});

it.each(["2030-13-40", "banana", "2030-1-7", "2030-02-30"])("rejects invalid date %s", (date) => {
  expect(() => generateSlots({ ...base, date, busy: [] })).toThrow(/^invalid_date$/);
});

it("allows a slot ending exactly at the rule end, not one minute over", () => {
  const run = (end: string) => generateSlots({ ...base, rules: [{ weekday: 1, start: "08:00", end }], durationMin: 50, bufferMin: 0, date: "2030-01-07", busy: [] });
  expect(run("08:50")).toEqual(["2030-01-07T06:00:00.000Z"]);
  expect(run("08:49")).toEqual([]);
});

it("a busy range whose buffer ends exactly at a slot start does not block it", () => {
  // busy 05:00-06:50Z with 10 min buffer blocks until 07:00Z
  const s = generateSlots({ ...base, date: "2030-01-07", busy: [{ start: "2030-01-07T05:00:00Z", end: "2030-01-07T06:50:00Z" }] });
  expect(s).not.toContain("2030-01-07T06:00:00.000Z");
  expect(s).toContain("2030-01-07T07:00:00.000Z");
  // one minute longer and the 07:00 slot is inside the buffer
  const s2 = generateSlots({ ...base, date: "2030-01-07", busy: [{ start: "2030-01-07T05:00:00Z", end: "2030-01-07T06:51:00Z" }] });
  expect(s2).not.toContain("2030-01-07T07:00:00.000Z");
});

it("handles unsorted and overlapping busy ranges", () => {
  const busy = [
    { start: "2030-01-07T07:00:00Z", end: "2030-01-07T08:00:00Z" },
    { start: "2030-01-07T05:30:00Z", end: "2030-01-07T07:30:00Z" },
  ];
  expect(generateSlots({ ...base, date: "2030-01-07", busy })).toEqual(["2030-01-07T09:00:00.000Z"]);
});

it("combines multiple rules on the same weekday into sorted, unique slots", () => {
  const multi = [
    { weekday: 1, start: "13:00", end: "17:00" },
    { weekday: 1, start: "08:00", end: "12:00" },
    { weekday: 1, start: "08:00", end: "12:00" },
  ];
  const s = generateSlots({ ...base, rules: multi, date: "2030-01-07", busy: [] });
  expect(s).toEqual([
    "2030-01-07T06:00:00.000Z",
    "2030-01-07T07:00:00.000Z",
    "2030-01-07T08:00:00.000Z",
    "2030-01-07T09:00:00.000Z",
    "2030-01-07T11:00:00.000Z",
    "2030-01-07T12:00:00.000Z",
    "2030-01-07T13:00:00.000Z",
    "2030-01-07T14:00:00.000Z",
  ]);
});
