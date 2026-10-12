import { describe, it, expect } from "vitest";
import {
  copyDay, dayMinutes, describeDay, findOverlap, formatHHMM, parseHHMM, validateDay, WEEK, windowProblem, windowsByWeekday, windowsFromValues, WEEKDAYS_MON_FRI,
} from "@/lib/settings/hours";
import { blockRange, clashText, localToInstant, overlapCount } from "@/lib/settings/blocks";

describe("HH:MM", () => {
  it("parses only clean 24-hour times", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("08:30")).toBe(510);
    expect(parseHHMM("23:55")).toBe(1435);
    for (const bad of ["8:00", "24:00", "12:60", "12:5", "1200", "", " 08:00", "08:00:00", "ab:cd"]) expect(parseHHMM(bad), bad).toBeNull();
    expect(formatHHMM(510)).toBe("08:30");
    expect(formatHHMM(0)).toBe("00:00");
  });
  it("enforces 5-minute steps and an end after the start", () => {
    expect(windowProblem({ start: "08:00", end: "12:30" })).toBeNull();
    expect(windowProblem({ start: "08:05", end: "08:10" })).toBeNull();
    expect(windowProblem({ start: "08:03", end: "12:00" })).toMatch(/5-minute/);
    expect(windowProblem({ start: "08:00", end: "12:07" })).toMatch(/5-minute/);
    expect(windowProblem({ start: "12:00", end: "08:00" })).toMatch(/end after/);
    expect(windowProblem({ start: "08:00", end: "08:00" })).toMatch(/end after/);
    expect(windowProblem({ start: "", end: "08:00" })).toMatch(/both times/);
  });
});

describe("overlap", () => {
  it("overlapping windows are found; touching and separate ones are not", () => {
    expect(findOverlap([{ start: "08:00", end: "12:00" }, { start: "11:55", end: "13:00" }])).toEqual([0, 1]);
    expect(findOverlap([{ start: "09:00", end: "10:00" }, { start: "08:00", end: "17:00" }])).toEqual([0, 1]); // contained, in any order
    expect(findOverlap([{ start: "08:00", end: "12:00" }, { start: "12:00", end: "17:00" }])).toBeNull();
    expect(findOverlap([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }])).toBeNull();
    expect(findOverlap([])).toBeNull();
    expect(findOverlap([{ start: "08:00", end: "09:00" }, { start: "08:00", end: "09:00" }])).toEqual([0, 1]); // the same window twice
  });
  it("validateDay sorts, and reports the first problem with the row", () => {
    const ok = validateDay([{ start: "13:00", end: "17:00" }, { start: "08:00", end: "12:00" }]);
    expect(ok).toEqual({ ok: true, windows: [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }] });
    expect(validateDay([])).toEqual({ ok: true, windows: [] }); // closed
    expect(validateDay([{ start: "08:00", end: "12:00" }, { start: "11:00", end: "13:00" }])).toMatchObject({ ok: false, index: 1, error: expect.stringMatching(/overlap/) });
    expect(validateDay([{ start: "08:00", end: "12:00" }, { start: "13:01", end: "14:00" }])).toMatchObject({ ok: false, index: 1 });
    expect(validateDay(Array.from({ length: 9 }, (_, i) => ({ start: `${String(i + 6).padStart(2, "0")}:00`, end: `${String(i + 6).padStart(2, "0")}:30` })))).toMatchObject({ ok: false, error: expect.stringMatching(/at most 8/) });
  });
});

describe("week", () => {
  it("is Monday first and maps to the database weekday (0 = Sunday)", () => {
    expect(WEEK.map((d) => d.label)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(WEEK.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect([...WEEKDAYS_MON_FRI]).toEqual([1, 2, 3, 4, 5]);
  });
  it("groups database rows by weekday, trims seconds and sorts", () => {
    const by = windowsByWeekday([
      { weekday: 1, start_time: "13:00:00", end_time: "17:00:00" }, { weekday: 1, start_time: "08:00:00", end_time: "12:00:00" }, { weekday: 0, start_time: "09:00:00", end_time: "10:00:00" },
    ]);
    expect(by[1]).toEqual([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }]);
    expect(by[0]).toEqual([{ start: "09:00", end: "10:00" }]);
    expect(by[2]).toEqual([]);
    expect(Object.keys(by)).toHaveLength(7);
  });
  it("copies a day to other days as independent lists", () => {
    const monday = [{ start: "08:00", end: "12:00" }];
    const c = copyDay(monday, WEEKDAYS_MON_FRI.filter((d) => d !== 1));
    expect(Object.keys(c)).toEqual(["2", "3", "4", "5"]);
    expect(c[2]).toEqual(monday);
    c[2][0].end = "09:00";
    expect(c[3][0].end).toBe("12:00");
    expect(monday[0].end).toBe("12:00");
    expect(copyDay([], [2])).toEqual({ 2: [] }); // copying a closed day closes the target
  });
  it("describes and totals a day", () => {
    expect(describeDay([])).toBe("Closed");
    expect(describeDay([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }])).toBe("08:00 to 12:00, 13:00 to 17:00");
    expect(dayMinutes([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:30" }])).toBe(510);
  });
  it("reads the numbered form fields in order, allowing gaps from removed rows", () => {
    expect(windowsFromValues({ start_0: " 08:00", end_0: "12:00", start_3: "13:00", end_3: "17:00", other: "x" })).toEqual([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }]);
    expect(windowsFromValues({})).toEqual([]);
    expect(windowsFromValues({ start_1: "09:00" })).toEqual([{ start: "09:00", end: "" }]); // a half-filled row is kept so validation can name it
  });
});

describe("blocked time", () => {
  const NOW = new Date("2031-05-01T06:00:00Z"); // 08:00 SAST
  it("reads datetime-local values as SAST", () => {
    expect(localToInstant("2031-05-02T08:00")).toBe("2031-05-02T06:00:00.000Z");
    expect(localToInstant("2031-05-02T00:30")).toBe("2031-05-01T22:30:00.000Z");
    for (const bad of ["", "2031-05-02", "2031-02-30T08:00", "2031-05-02T25:00", "2031-05-02 08:00"]) expect(localToInstant(bad), bad).toBeNull();
  });
  it("accepts a sensible range and refuses the rest with the field to flag", () => {
    expect(blockRange("2031-05-02T08:00", "2031-05-02T17:00", NOW)).toEqual({ ok: true, value: { startsAt: "2031-05-02T06:00:00.000Z", endsAt: "2031-05-02T15:00:00.000Z" } });
    expect(blockRange("2031-05-01T08:00", "2031-05-01T12:00", NOW).ok).toBe(true); // started already, still ends in the future
    expect(blockRange("", "2031-05-02T17:00", NOW)).toMatchObject({ ok: false, field: "starts" });
    expect(blockRange("2031-05-02T08:00", "x", NOW)).toMatchObject({ ok: false, field: "ends" });
    expect(blockRange("2031-05-02T17:00", "2031-05-02T08:00", NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/end after/) });
    expect(blockRange("2031-05-02T08:00", "2031-05-02T08:00", NOW)).toMatchObject({ ok: false });
    expect(blockRange("2031-04-01T08:00", "2031-04-02T08:00", NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/future/) });
    expect(blockRange("2031-05-02T08:00", "2032-06-02T08:00", NOW)).toMatchObject({ ok: false, error: expect.stringMatching(/year/) });
  });
  it("counts appointments inside a block; touching the edge is not inside", () => {
    const block = { starts_at: "2031-05-02T06:00:00Z", ends_at: "2031-05-02T10:00:00Z" };
    const a = (s: string, e: string) => ({ starts_at: `2031-05-02T${s}:00Z`, ends_at: `2031-05-02T${e}:00Z` });
    expect(overlapCount(block, [a("05:00", "06:00"), a("10:00", "11:00")])).toBe(0);
    expect(overlapCount(block, [a("05:30", "06:20"), a("09:50", "10:40"), a("07:00", "07:50"), a("11:00", "12:00")])).toBe(3);
    expect(overlapCount(block, [])).toBe(0);
  });
  it("words the warning in the singular and plural, and says nothing for zero", () => {
    expect(clashText(0)).toBe("");
    expect(clashText(1)).toBe("1 appointment falls inside this time. It is not cancelled or moved automatically.");
    expect(clashText(3)).toMatch(/^3 appointments fall inside this time\. They are not cancelled/);
  });
});

import { windowsKey } from "@/lib/settings/hours";
import { formKey } from "@/lib/settings/keys";

describe("windowsFromValues survives the real form numbering", () => {
  it("60 add/remove cycles: keys keep growing, gaps are fine, order follows the numbers", () => {
    const v: Record<string, string> = {};
    for (let i = 0; i < 60; i++) { v[`start_${i}`] = "08:00"; v[`end_${i}`] = "09:00"; if (i % 2 === 0) { delete v[`start_${i}`]; delete v[`end_${i}`]; } } // every even row removed
    v.start_61 = "10:00"; v.end_61 = "11:00";
    const ws = windowsFromValues(v);
    expect(ws).toHaveLength(31);
    expect(ws.at(-1)).toEqual({ start: "10:00", end: "11:00" });
    expect(validateDay(ws)).toMatchObject({ ok: false, error: expect.stringMatching(/at most 8/) }); // a friendly error, not a crash
  });
  it("numbers sort numerically (10 after 9), not as text", () => {
    expect(windowsFromValues({ start_10: "13:00", end_10: "14:00", start_9: "09:00", end_9: "10:00" }).map((w) => w.start)).toEqual(["09:00", "13:00"]);
  });
  it("crafted keys and values give a validation message, never an exception", () => {
    const crafted = {
      start_0: { toString() { throw new Error("boom"); } }, end_0: ["12:00"], "start_-1": "08:00", start_x: "08:00", "start_99999999999999999999": "08:00", __proto__: "x", constructor: "y",
      start_1: 5, end_1: null, start_2: undefined, end_2: "12:00",
    } as unknown as Record<string, string>;
    let ws: ReturnType<typeof windowsFromValues> = [];
    expect(() => { ws = windowsFromValues(crafted); }).not.toThrow();
    const r = validateDay(ws);
    expect(r.ok).toBe(false);
    expect(windowsFromValues(null as unknown as Record<string, string>)).toEqual([]);
    expect(windowsFromValues("x" as unknown as Record<string, string>)).toEqual([]);
  });
  it("a window with only one side filled is kept so validation can name it", () => {
    expect(validateDay(windowsFromValues({ start_3: "09:00" }))).toMatchObject({ ok: false, error: expect.stringMatching(/both times/) });
  });
});

describe("form keys follow the server data", () => {
  it("a day's key changes when its saved windows change and is stable otherwise", () => {
    const a = [{ start: "08:00", end: "12:00" }], b = [{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }];
    expect(windowsKey(1, a)).toBe(windowsKey(1, [...a]));
    expect(windowsKey(1, a)).not.toBe(windowsKey(1, b));
    expect(windowsKey(1, a)).not.toBe(windowsKey(2, a));
    expect(windowsKey(1, [])).not.toBe(windowsKey(1, a)); // closed vs open
  });
  it("formKey separates its parts", () => {
    expect(formKey("a", 1, null, false)).toBe(formKey("a", 1, null, false));
    expect(formKey("ab", "c")).not.toBe(formKey("a", "bc"));
    expect(formKey("x", 10, 6)).not.toBe(formKey("x", 10, null));
  });
});
