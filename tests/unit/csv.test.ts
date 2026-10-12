import { describe, it, expect } from "vitest";
import { toCsv, csvCell } from "@/lib/reports/csv";

describe("toCsv", () => {
  it("escapes csv and blocks formula injection (the plan's check)", () => {
    expect(toCsv([{ a: 'x,"y"', b: "=1+1" }])).toBe('a,b\n"x,""y""",\'=1+1');
  });
  it("quotes commas, quotes, newlines and carriage returns", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
    expect(csvCell("plain")).toBe("plain");
  });
  it("prefixes every formula starter with a single quote, quoting afterwards when needed", () => {
    for (const s of ["=SUM(A1)", "+27821234567", "-2+3", "@cmd", "\tx", "\rx"]) expect(csvCell(s).replace(/^"/, "")).toMatch(/^'/);
    expect(csvCell("=HYPERLINK(\"http://x\",\"y\")")).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
    expect(csvCell("a=b")).toBe("a=b"); // only the first character matters
  });
  it("leaves numbers alone (a negative number is data, not a formula) and writes null as empty", () => {
    expect(toCsv([{ n: -5, m: 12.5, z: null }])).toBe("n,m,z\n-5,12.5,");
  });
  it("uses the first row's keys, missing cells are empty, and header cells are protected too", () => {
    expect(toCsv([{ a: "1", b: "2" }, { a: "3" } as Record<string, string>])).toBe("a,b\n1,2\n3,");
    expect(toCsv([{ "=evil": "x" }])).toBe("'=evil\nx");
  });
  it("returns an empty string for no rows, or just the header when the columns are given", () => {
    expect(toCsv([])).toBe("");
    expect(toCsv([], ["a", "b"])).toBe("a,b");
  });
});
