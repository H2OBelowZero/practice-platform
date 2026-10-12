import { describe, it, expect } from "vitest";
import { advisories, evaluate } from "../../scripts/audit-check.mjs";

const adv = (id: string, severity: string, name = "pkg") => ({ name, source: 1, url: `https://github.com/advisories/${id}`, severity, title: `t ${id}`, range: "<1" });
const report = (...v: [string, unknown[]][]) => ({ vulnerabilities: Object.fromEntries(v.map(([k, via]) => [k, { via }])) });
const today = new Date("2026-10-12");
const entry = (id: string, reviewed = "2026-10-01") => ({ id, reason: "r", reviewed });

describe("advisories()", () => {
  it("collects advisory objects once, ignores package-name strings (transitive carriers)", () => {
    const r = report(["next", ["postcss"]], ["postcss", [adv("GHSA-aaaa", "high", "postcss"), adv("GHSA-aaaa", "high", "postcss")]]);
    expect(advisories(r).map((a) => a.id)).toEqual(["GHSA-aaaa"]);
  });
});

describe("evaluate()", () => {
  it("passes when every advisory is allow-listed, whatever its severity", () => {
    const r = evaluate({ audit: report(["p", [adv("GHSA-a", "high"), adv("GHSA-b", "critical")]]), allowlist: [entry("GHSA-a"), entry("GHSA-b")], today });
    expect(r.blocking).toEqual([]);
    expect(r.accepted.map((a) => a.id)).toEqual(["GHSA-a", "GHSA-b"]);
  });
  it("blocks a NEW high or critical advisory", () => {
    for (const sev of ["high", "critical"]) {
      const r = evaluate({ audit: report(["p", [adv("GHSA-a", "high"), adv("GHSA-new", sev)]]), allowlist: [entry("GHSA-a")], today });
      expect(r.blocking.map((a) => a.id)).toEqual(["GHSA-new"]);
    }
  });
  it("does not block a new moderate or low advisory, but reports it", () => {
    const r = evaluate({ audit: report(["p", [adv("GHSA-m", "moderate"), adv("GHSA-l", "low")]]), allowlist: [], today });
    expect(r.blocking).toEqual([]);
    expect(r.warnings.map((a) => a.id)).toEqual(["GHSA-m", "GHSA-l"]);
  });
  it("passes a clean report", () => {
    expect(evaluate({ audit: { vulnerabilities: {} }, allowlist: [], today }).blocking).toEqual([]);
  });
  it("reports (never fails on) entries older than 90 days and entries that match nothing", () => {
    const r = evaluate({ audit: report(["p", [adv("GHSA-a", "high")]]), allowlist: [entry("GHSA-a", "2026-06-01"), entry("GHSA-gone")], today });
    expect(r.blocking).toEqual([]);
    expect(r.stale).toEqual(["GHSA-a"]);
    expect(r.unused).toEqual(["GHSA-gone"]);
  });
  it("an allow-list entry without a reason or a review date is itself a failure", () => {
    const r = evaluate({ audit: report(["p", [adv("GHSA-a", "high")]]), allowlist: [{ id: "GHSA-a", reason: "", reviewed: "soon" }], today });
    expect(r.blocking.map((a) => a.severity)).toContain("invalid");
  });
  it("refuses an unusable report instead of passing (registry down, error payload)", () => {
    expect(() => evaluate({ audit: { error: { summary: "ENOTFOUND" } }, allowlist: [], today })).toThrow(/no usable report: ENOTFOUND/);
    expect(() => evaluate({ audit: null, allowlist: [], today })).toThrow();
  });
  it("matches ids from the advisory URL, falling back to the numeric source", () => {
    expect(advisories(report(["p", [{ name: "p", source: 42, severity: "high", title: "x" }]]))[0].id).toBe("npm-42");
  });
});
