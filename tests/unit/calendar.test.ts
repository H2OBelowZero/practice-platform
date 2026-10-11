import { describe, it, expect } from "vitest";
import { weekStart, viewRange, stepDate, rangeBoundsUtc, parseView, parseDate, calendarHref } from "@/lib/calendar/range";
import { minuteOfDay, blockPosition, assignLanes, gridHours, groupByDay, overlapsDay } from "@/lib/calendar/grid";
import { sastInstant, sastMidnight } from "@/lib/time";

describe("week math (Monday start)", () => {
  it("finds Monday for every weekday", () => {
    // 2031-01-06 is a Monday
    for (const [d, mon] of [["2031-01-06", "2031-01-06"], ["2031-01-08", "2031-01-06"], ["2031-01-12", "2031-01-06"], ["2031-01-13", "2031-01-13"]]) expect(weekStart(d)).toBe(mon);
  });
  it("crosses month and year boundaries", () => {
    expect(weekStart("2031-03-02")).toBe("2031-02-24"); // Sunday 2 March -> Monday 24 Feb
    expect(weekStart("2031-01-01")).toBe("2030-12-30"); // Wednesday -> Monday in the previous year
    expect(viewRange("week", "2031-01-01").days).toEqual(["2030-12-30", "2030-12-31", "2031-01-01", "2031-01-02", "2031-01-03", "2031-01-04", "2031-01-05"]);
  });
  it("handles a leap day", () => {
    expect(weekStart("2032-02-29")).toBe("2032-02-23"); // Sunday
    expect(viewRange("week", "2032-02-25").last).toBe("2032-02-29");
    expect(stepDate("week", "2032-02-25", 1)).toBe("2032-03-01");
  });
});

describe("views and stepping", () => {
  it("day, week, agenda ranges", () => {
    expect(viewRange("day", "2031-05-14")).toMatchObject({ first: "2031-05-14", last: "2031-05-14" });
    expect(viewRange("week", "2031-05-14")).toMatchObject({ first: "2031-05-12", last: "2031-05-18" });
    const a = viewRange("agenda", "2031-12-25");
    expect(a.days).toHaveLength(14); expect(a.last).toBe("2032-01-07");
  });
  it("previous and next", () => {
    expect(stepDate("day", "2031-03-01", -1)).toBe("2031-02-28");
    expect(stepDate("week", "2031-05-14", 1)).toBe("2031-05-19");
    expect(stepDate("week", "2031-05-14", -1)).toBe("2031-05-05");
    expect(stepDate("agenda", "2031-12-25", 1)).toBe("2032-01-08");
  });
  it("parses params defensively", () => {
    expect(parseView(undefined)).toBe("week"); expect(parseView("month")).toBe("week"); expect(parseView("agenda")).toBe("agenda");
    const now = new Date("2031-06-30T22:30:00Z"); // 00:30 on 1 July in SAST
    expect(parseDate(undefined, now)).toBe("2031-07-01");
    expect(parseDate("2031-02-30", now)).toBe("2031-07-01");
    expect(parseDate("2031-02-28", now)).toBe("2031-02-28");
  });
  it("keeps filters in links and drops empty ones", () => {
    expect(calendarHref({ view: "day", date: "2031-01-06" })).toBe("/app/calendar?view=day&date=2031-01-06");
    expect(calendarHref({ view: "week", date: "2031-01-06", status: "confirmed", q: "van der Merwe" })).toBe("/app/calendar?view=week&date=2031-01-06&status=confirmed&q=van+der+Merwe");
  });
});

describe("SAST day boundaries", () => {
  it("midnight SAST is 22:00 UTC the day before", () => {
    expect(sastMidnight("2031-01-06")).toBe("2031-01-05T22:00:00.000Z");
    expect(rangeBoundsUtc("2031-01-06", "2031-01-12")).toEqual({ from: "2031-01-05T22:00:00.000Z", to: "2031-01-12T22:00:00.000Z" });
    expect(rangeBoundsUtc("2031-12-31", "2031-12-31")).toEqual({ from: "2031-12-30T22:00:00.000Z", to: "2031-12-31T22:00:00.000Z" });
  });
  it("wall-clock to instant", () => {
    expect(sastInstant("2031-01-06", "09:30")).toBe("2031-01-06T07:30:00.000Z");
    expect(sastInstant("2031-01-06", "00:15")).toBe("2031-01-05T22:15:00.000Z");
    expect(sastInstant("2031-02-30", "09:00")).toBeNull();
    expect(sastInstant("2031-01-06", "24:00")).toBeNull();
    expect(sastInstant("2031-01-06", "9:00")).toBeNull();
  });
  it("minutes into the SAST day, clamped", () => {
    expect(minuteOfDay("2031-01-06T07:30:00.000Z", "2031-01-06")).toBe(9 * 60 + 30);
    expect(minuteOfDay("2031-01-05T22:00:00.000Z", "2031-01-06")).toBe(0);   // exactly SAST midnight
    expect(minuteOfDay("2031-01-05T21:59:00.000Z", "2031-01-06")).toBe(0);   // the day before: stuck to the edge
    expect(minuteOfDay("2031-01-06T22:30:00.000Z", "2031-01-06")).toBe(1440); // next SAST day
  });
  it("an appointment late in the evening UTC belongs to the next SAST day", () => {
    const a = { starts_at: "2031-01-06T22:30:00.000Z", ends_at: "2031-01-06T23:20:00.000Z" }; // 00:30 on the 7th in SAST
    expect(overlapsDay([a], "2031-01-06")).toHaveLength(0);
    expect(overlapsDay([a], "2031-01-07")).toHaveLength(1);
    expect(groupByDay([a], ["2031-01-06", "2031-01-07"]).map((g) => g.items.length)).toEqual([0, 1]);
  });
  it("an appointment across SAST midnight shows on both days", () => {
    const a = { starts_at: "2031-01-06T21:30:00.000Z", ends_at: "2031-01-06T22:30:00.000Z" }; // 23:30 to 00:30
    expect(overlapsDay([a], "2031-01-06")).toHaveLength(1);
    expect(overlapsDay([a], "2031-01-07")).toHaveLength(1);
  });
});

describe("grid positioning", () => {
  it("positions in percent of the grid height", () => {
    // grid 08:00-17:00 = 540 minutes; 09:00-09:50
    const p = blockPosition(9 * 60, 9 * 60 + 50, 8 * 60, 17 * 60);
    expect(p.top).toBeCloseTo(60 / 540 * 100); expect(p.height).toBeCloseTo(50 / 540 * 100);
  });
  it("clamps to the grid and keeps tiny blocks visible", () => {
    expect(blockPosition(7 * 60, 9 * 60, 8 * 60, 17 * 60)).toMatchObject({ top: 0 });
    const late = blockPosition(16 * 60, 18 * 60, 8 * 60, 17 * 60);
    expect(late.top + late.height).toBeCloseTo(100);
    expect(blockPosition(600, 605, 480, 1020).height).toBeCloseTo(20 / 540 * 100);
  });
  it("grid hours come from the rules and widen for appointments outside them", () => {
    expect(gridHours([], [])).toEqual({ startHour: 8, endHour: 17 });
    expect(gridHours([{ start: "08:30", end: "16:00" }, { start: "09:00", end: "17:15" }], [])).toEqual({ startHour: 8, endHour: 18 });
    expect(gridHours([{ start: "08:00", end: "17:00" }], [{ startMin: 7 * 60 + 15, endMin: 8 * 60 }, { startMin: 18 * 60, endMin: 19 * 60 + 5 }])).toEqual({ startHour: 7, endHour: 20 });
    expect(gridHours([], [{ startMin: 23 * 60, endMin: 1440 }])).toEqual({ startHour: 23, endHour: 24 });
  });
});

describe("overlapping blocks", () => {
  const b = (id: string, startMin: number, endMin: number) => ({ id, startMin, endMin });
  const lanes = (xs: ReturnType<typeof b>[]) => Object.fromEntries(assignLanes(xs).map((x) => [x.id, [x.lane, x.lanes]]));
  it("separate blocks use the full width", () => {
    expect(lanes([b("a", 540, 590), b("c", 600, 650)])).toEqual({ a: [0, 1], c: [0, 1] });
  });
  it("touching blocks do not overlap", () => {
    expect(lanes([b("a", 540, 590), b("c", 590, 640)])).toEqual({ a: [0, 1], c: [0, 1] });
  });
  it("two overlapping blocks sit side by side", () => {
    expect(lanes([b("a", 540, 590), b("c", 570, 620)])).toEqual({ a: [0, 2], c: [1, 2] });
  });
  it("a chain shares one cluster; a later block reuses a freed lane", () => {
    // a 9:00-10:30 overlaps c 9:30-10:00 and d 10:00-11:00 (d starts when c ends, so it reuses lane 1)
    expect(lanes([b("a", 540, 630), b("c", 570, 600), b("d", 600, 660)])).toEqual({ a: [0, 2], c: [1, 2], d: [1, 2] });
  });
  it("three at once need three lanes, a later separate block is unaffected", () => {
    expect(lanes([b("a", 540, 600), b("c", 545, 600), b("d", 550, 600), b("e", 700, 750)])).toEqual({ a: [0, 3], c: [1, 3], d: [2, 3], e: [0, 1] });
  });
  it("input order does not matter and nothing is lost", () => {
    const out = assignLanes([b("c", 570, 620), b("a", 540, 590)]);
    expect(out.map((x) => x.id)).toEqual(["a", "c"]);
  });
});

describe("agenda grouping", () => {
  it("keeps empty days and sorts by start", () => {
    const g = groupByDay([{ starts_at: "2031-01-07T09:00:00.000Z", n: 2 }, { starts_at: "2031-01-07T07:00:00.000Z", n: 1 }], ["2031-01-06", "2031-01-07", "2031-01-08"]);
    expect(g.map((x) => x.items.map((i) => i.n))).toEqual([[], [1, 2], []]);
  });
});

describe("period heading", () => {
  it("day shows the full date, others a range with years", async () => {
    const { rangeLabel } = await import("@/lib/calendar/range");
    expect(rangeLabel("day", "2031-01-06", "2031-01-06")).toBe("Monday, 6 January 2031");
    expect(rangeLabel("week", "2030-12-30", "2031-01-05")).toBe("Mon 30 Dec 2030 to Sun 5 Jan 2031");
  });
});
