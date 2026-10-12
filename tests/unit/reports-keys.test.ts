import { describe, it, expect } from "vitest";
import type { Role } from "@/lib/auth/roles";
import { canExport, EXPORT_KEYS, EXPORT_ROLES, exportQuery, parseTab, tabsFor, type ExportKey } from "@/lib/reports/keys";

const ROLES: Role[] = ["psychologist", "admin", "bookkeeper", "associate", "patient", "guardian"];

describe("report tabs by role", () => {
  it("psychologist sees four, admin three (no Compliance), bookkeeper Financial only, everyone else nothing", () => {
    expect(tabsFor("psychologist").map((t) => t.key)).toEqual(["financial", "appointments", "activity", "compliance"]);
    expect(tabsFor("admin").map((t) => t.key)).toEqual(["financial", "appointments", "activity"]);
    expect(tabsFor("bookkeeper").map((t) => t.key)).toEqual(["financial"]);
    for (const r of ["associate", "patient", "guardian"] as Role[]) expect(tabsFor(r)).toEqual([]);
  });
  it("labels", () => {
    expect(tabsFor("psychologist").map((t) => t.label)).toEqual(["Financial", "Appointments", "Practice activity", "Compliance"]);
  });
  it("a tab the role may not see falls back to the first one it may see", () => {
    expect(parseTab("compliance", "bookkeeper")).toBe("financial");
    expect(parseTab("appointments", "bookkeeper")).toBe("financial");
    expect(parseTab("compliance", "admin")).toBe("financial");
    expect(parseTab("compliance", "psychologist")).toBe("compliance");
    expect(parseTab("activity", "admin")).toBe("activity");
    expect(parseTab(undefined, "psychologist")).toBe("financial");
    expect(parseTab("nonsense", "admin")).toBe("financial");
  });
});

describe("export keys and who may download them", () => {
  it("the whitelist is exactly the eight reports", () => {
    expect([...EXPORT_KEYS]).toEqual(["income_by_month", "income_by_method", "income_by_session_type", "debtors", "appointments", "activity", "compliance", "transactions"]);
  });
  it("role matrix", () => {
    const allowed = (k: ExportKey) => ROLES.filter((r) => canExport(r, k));
    for (const k of ["income_by_month", "income_by_method", "income_by_session_type", "debtors", "transactions"] as const) expect(allowed(k), k).toEqual(["psychologist", "admin", "bookkeeper"]);
    for (const k of ["appointments", "activity"] as const) expect(allowed(k), k).toEqual(["psychologist", "admin"]);
    expect(allowed("compliance")).toEqual(["psychologist"]);
    expect(Object.keys(EXPORT_ROLES).sort()).toEqual([...EXPORT_KEYS].sort());
  });
  it("a bookkeeper may export only financial reports, which are exactly the Financial tab's", () => {
    expect(EXPORT_KEYS.filter((k) => canExport("bookkeeper", k)).sort()).toEqual(["debtors", "income_by_method", "income_by_month", "income_by_session_type", "transactions"]);
  });
});

describe("exportQuery (Zod)", () => {
  const ok = { report: "transactions", from: "2030-01-01", to: "2030-03-31" };
  it("accepts a whitelisted report and a real range", () => {
    expect(exportQuery.safeParse(ok).success).toBe(true);
  });
  it("rejects an unknown report, missing or malformed dates, reversed or over-long ranges", () => {
    for (const bad of [
      { ...ok, report: "audit_log" }, { ...ok, report: "../etc" }, { ...ok, report: null }, { ...ok, from: null }, { ...ok, to: "" },
      { ...ok, from: "2030-02-30" }, { ...ok, from: "01/01/2030" }, { ...ok, from: "2030-03-31", to: "2030-01-01" }, { ...ok, from: "2020-01-01", to: "2030-01-01" },
    ]) expect(exportQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
