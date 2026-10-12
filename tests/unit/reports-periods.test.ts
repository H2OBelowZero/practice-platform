import { describe, it, expect } from "vitest";
import { addMonths, debtorsAsOf, DEFAULT_PRESET, MAX_SPAN_DAYS, parsePeriod, presetRange, rangeProblem, rangeText } from "@/lib/reports/periods";

describe("addMonths", () => {
  it("moves by whole months across year ends", () => {
    expect(addMonths("2030-03-01", -1)).toBe("2030-02-01");
    expect(addMonths("2030-01-01", -1)).toBe("2029-12-01");
    expect(addMonths("2030-01-17", -2)).toBe("2029-11-01");
    expect(addMonths("2030-11-01", 3)).toBe("2031-02-01");
    expect(addMonths("2030-12-01", 0)).toBe("2030-12-01");
  });
});

describe("presetRange (SAST dates)", () => {
  it("mid month", () => {
    expect(presetRange("this_month", "2030-03-15")).toEqual({ from: "2030-03-01", to: "2030-03-15" });
    expect(presetRange("last_month", "2030-03-15")).toEqual({ from: "2030-02-01", to: "2030-02-28" });
    expect(presetRange("last_3_months", "2030-03-15")).toEqual({ from: "2030-01-01", to: "2030-03-15" });
    expect(presetRange("this_year", "2030-03-15")).toEqual({ from: "2030-01-01", to: "2030-03-15" });
  });
  it("last month in a leap year ends on the 29th, in an ordinary year on the 28th", () => {
    expect(presetRange("last_month", "2028-03-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(presetRange("last_month", "2030-03-10")).toEqual({ from: "2030-02-01", to: "2030-02-28" });
    expect(presetRange("this_month", "2028-02-29")).toEqual({ from: "2028-02-01", to: "2028-02-29" }); // the leap day itself
  });
  it("first and last day of a month and of a year", () => {
    expect(presetRange("last_month", "2030-03-01")).toEqual({ from: "2030-02-01", to: "2030-02-28" });
    expect(presetRange("this_month", "2030-03-01")).toEqual({ from: "2030-03-01", to: "2030-03-01" });
    expect(presetRange("this_month", "2030-12-31")).toEqual({ from: "2030-12-01", to: "2030-12-31" });
    expect(presetRange("this_year", "2030-12-31")).toEqual({ from: "2030-01-01", to: "2030-12-31" });
    expect(presetRange("this_year", "2030-01-01")).toEqual({ from: "2030-01-01", to: "2030-01-01" });
  });
  it("across a year boundary", () => {
    expect(presetRange("last_month", "2030-01-05")).toEqual({ from: "2029-12-01", to: "2029-12-31" });
    expect(presetRange("last_3_months", "2030-01-05")).toEqual({ from: "2029-11-01", to: "2030-01-05" });
    expect(presetRange("last_3_months", "2030-02-01")).toEqual({ from: "2029-12-01", to: "2030-02-01" });
  });
  it("every preset stays inside what the database accepts (at most 800 days)", () => {
    for (const today of ["2030-01-01", "2030-03-31", "2028-02-29", "2030-12-31"])
      for (const p of ["this_month", "last_month", "last_3_months", "this_year"] as const) {
        const r = presetRange(p, today);
        expect(rangeProblem(r.from, r.to)).toBeNull();
      }
  });
});

describe("rangeProblem", () => {
  it("accepts a good range, a single day and exactly 800 days", () => {
    expect(rangeProblem("2030-01-01", "2030-03-31")).toBeNull();
    expect(rangeProblem("2030-01-01", "2030-01-01")).toBeNull();
    expect(rangeProblem("2030-01-01", "2032-03-11")).toBeNull(); // 800 days later
    expect(MAX_SPAN_DAYS).toBe(800);
  });
  it("refuses unreal, reversed, too long and out-of-range dates", () => {
    expect(rangeProblem("2030-02-30", "2030-03-01")).toMatch(/real calendar dates/);
    expect(rangeProblem("", "2030-03-01")).toMatch(/real calendar dates/);
    expect(rangeProblem("2030-03-01", "2030-3-31")).toMatch(/real calendar dates/);
    expect(rangeProblem("2030-03-31", "2030-03-01")).toMatch(/cannot be after/);
    expect(rangeProblem("2030-01-01", "2032-03-12")).toMatch(/at most 800 days/); // 801 days
    expect(rangeProblem("1999-12-31", "2000-01-02")).toMatch(/between the years/);
    expect(rangeProblem("2099-12-31", "2101-01-01")).toMatch(/between the years/);
  });
});

describe("parsePeriod", () => {
  const today = "2030-03-15";
  it("defaults to the last 3 months", () => {
    expect(DEFAULT_PRESET).toBe("last_3_months");
    expect(parsePeriod({}, today)).toEqual({ preset: "last_3_months", from: "2030-01-01", to: "2030-03-15", problem: null });
  });
  it("a named preset wins over any dates", () => {
    expect(parsePeriod({ preset: "last_month", from: "garbage", to: "2030-99-99" }, today)).toEqual({ preset: "last_month", from: "2030-02-01", to: "2030-02-28", problem: null });
  });
  it("custom dates are used when valid, and also when given without a preset", () => {
    expect(parsePeriod({ preset: "custom", from: "2030-02-10", to: "2030-02-20" }, today)).toEqual({ preset: "custom", from: "2030-02-10", to: "2030-02-20", problem: null });
    expect(parsePeriod({ from: "2030-02-10", to: "2030-02-20" }, today).preset).toBe("custom");
  });
  it("bad custom dates fall back to the default and say why", () => {
    for (const sp of [
      { preset: "custom", from: "2030-02-20", to: "2030-02-10" }, { preset: "custom", from: "2030-02-10" }, { preset: "custom" },
      { preset: "custom", from: "2030-02-30", to: "2030-03-01" }, { preset: "custom", from: "2020-01-01", to: "2030-03-01" }, { from: "x", to: "y" },
    ]) {
      const p = parsePeriod(sp, today);
      expect(p.preset, JSON.stringify(sp)).toBe("last_3_months");
      expect(p.from).toBe("2030-01-01");
      expect(p.problem, JSON.stringify(sp)).toBeTruthy();
    }
  });
  it("an unknown preset word is ignored (no error), and cannot smuggle anything into a query", () => {
    expect(parsePeriod({ preset: "yesterday'; drop table" }, today)).toEqual({ preset: "last_3_months", from: "2030-01-01", to: "2030-03-15", problem: null });
  });
});

describe("text and debtors date", () => {
  it("range text", () => {
    expect(rangeText({ from: "2030-01-01", to: "2030-03-31" })).toBe("1 Jan 2030 to 31 Mar 2030");
    expect(rangeText({ from: "2030-03-05", to: "2030-03-05" })).toBe("5 Mar 2030");
  });
  it("debtors are as at the end of the period, never in the future", () => {
    expect(debtorsAsOf("2030-02-28", "2030-03-15")).toBe("2030-02-28");
    expect(debtorsAsOf("2030-03-15", "2030-03-15")).toBe("2030-03-15");
    expect(debtorsAsOf("2030-12-31", "2030-03-15")).toBe("2030-03-15");
  });
});
