import { describe, it, expect } from "vitest";
import { formatZar, parseZarToCents } from "@/lib/money";

describe("formatZar", () => {
  it.each([
    [0, "R 0,00"], [5, "R 0,05"], [99, "R 0,99"], [100, "R 1,00"], [123450, "R 1 234,50"],
    [-12345, "-R 123,45"], [-5, "-R 0,05"], [100000000, "R 1 000 000,00"], [99999, "R 999,99"], [100000, "R 1 000,00"],
  ])("%i -> %s", (c, s) => expect(formatZar(c)).toBe(s));
  it("groups thousands with a regular space (U+0020), not a no-break space", () => {
    expect(formatZar(100000000)).toContain("1 000 000");
    expect(formatZar(100000000)).not.toMatch(/[  ]/);
  });
});

describe("parseZarToCents", () => {
  it.each([
    ["1234.50", 123450], ["1 234,50", 123450], ["R1234", 123400], ["R 1 234,50", 123450], ["r1234", 123400], ["0", 0], ["0.05", 5],
    ["950", 95000], ["950.5", 95050], ["950,5", 95050], ["  12.30  ", 1230], ["1 000 000", 100000000], ["1 234,50", 123450],
    ["21474836.47", 2147483647],
  ])("accepts %j -> %i", (s, c) => expect(parseZarToCents(s)).toBe(c));
  it.each([
    "", " ", "abc", "R", "-5", "-0.50", "+5", "1.234", "1.234,50", "1,234.50", "12.345", "1e3", "1.5e2", "0x10", "1..5", "1.", ".5", "R-5",
    "1 23", "12 3456", "1  234", "NaN", "Infinity", "21474836.48", "99999999999999999999", "1,2,3", "R R5", "5 R",
  ])("rejects %j", (s) => expect(parseZarToCents(s)).toBeNull());
  it("round-trips formatZar output", () => {
    for (const c of [0, 5, 99, 100, 123450, 100000000]) expect(parseZarToCents(formatZar(c))).toBe(c);
  });
});
