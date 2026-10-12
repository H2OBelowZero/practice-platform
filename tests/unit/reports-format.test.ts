import { describe, it, expect } from "vitest";
import { barWidth, formatPercent, minutesText, monthLabel, percentNumber, zar } from "@/lib/reports/format";

describe("report formatting", () => {
  it("percentages have one decimal and n/a for nothing to divide by", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.25)).toBe("25.0%");
    expect(formatPercent(0.2636)).toBe("26.4%");
    expect(formatPercent(1 / 3)).toBe("33.3%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(null)).toBe("n/a");
    expect(formatPercent(undefined)).toBe("n/a");
    expect(formatPercent(Number.NaN)).toBe("n/a");
  });
  it("the same figure for a CSV cell", () => {
    expect(percentNumber(0.2636)).toBe(26.4);
    expect(percentNumber(0.25)).toBe(25);
    expect(percentNumber(null)).toBeNull();
  });
  it("month labels", () => {
    expect(monthLabel("2030-01-01")).toBe("Jan 2030");
    expect(monthLabel("2030-12")).toBe("Dec 2030");
    expect(monthLabel("2029-02-15")).toBe("Feb 2029");
    expect(monthLabel("2030-13-01")).toBe("2030-13-01");
    expect(monthLabel("nonsense")).toBe("nonsense");
  });
  it("bar widths are whole percents between 0 and 100", () => {
    expect(barWidth(50, 100)).toBe(50);
    expect(barWidth(100, 100)).toBe(100);
    expect(barWidth(200, 100)).toBe(100); // never wider than the cell
    expect(barWidth(0, 100)).toBe(0);
    expect(barWidth(-5, 100)).toBe(0);
    expect(barWidth(5, 0)).toBe(0);
    expect(barWidth(1, 1000)).toBe(1); // a tiny but real value is still visible
    expect(barWidth(Number.NaN, 10)).toBe(0);
    expect(barWidth(1, Infinity)).toBe(0);
  });
  it("money for a CSV is a plain number of rand", () => {
    expect(zar(123450)).toBe(1234.5);
    expect(zar(-115)).toBe(-1.15);
    expect(zar(7)).toBe(0.07);
    expect(zar(null)).toBeNull();
  });
  it("minutes", () => {
    expect(minutesText(0)).toBe("0 min");
    expect(minutesText(45)).toBe("45 min");
    expect(minutesText(120)).toBe("2 h");
    expect(minutesText(340)).toBe("5 h 40 min");
  });
});
