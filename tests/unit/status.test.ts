import { it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATUS, statusMeta } from "@/lib/status";
import { formatZar } from "@/lib/money";
import { staffNav, staffPhoneNav, portalNav } from "@/lib/nav";

const dir = join(__dirname, "..", "..", "supabase", "migrations");
const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

/** every value in `check (status in (...))` / `check (state in (...))` column constraints, from the real migrations */
function dbStatusValues(): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/\b(?:status|state) text[^,]*?check \((?:status|state) in \(([^)]*)\)/g))
    for (const v of m[1].matchAll(/'([a-z_]+)'/g)) out.add(v[1]);
  return [...out];
}

it("the status map covers every status value the database accepts (so none can render as colour-only or blank)", () => {
  const values = dbStatusValues();
  expect(values.length).toBeGreaterThan(20); // the scan really found them
  for (const must of ["tentative", "confirmed", "no_show", "part_paid", "paid", "issued", "draft", "cancelled", "attended"]) expect(values).toContain(must);
  expect(values.filter((v) => !(v in STATUS))).toEqual([]);
});

it("every status has an icon and a text label; unknown values still get both", () => {
  for (const [k, m] of Object.entries(STATUS)) { expect(m.label.length, k).toBeGreaterThan(0); expect(m.icon, k).toBeTruthy(); }
  expect(statusMeta("overdue")).toMatchObject({ label: "Overdue", tone: "danger" });
  expect(statusMeta("tentative").label).toBe("Requested");
  expect(statusMeta("some_new_state")).toMatchObject({ label: "Some new state", tone: "neutral" });
});

it("built-in status labels are short enough to stay on one line at 375px (chips wrap for longer overrides)", () => {
  // text-sm is about 7px per character; icon + padding add about 50px, and the phone content area is 343px wide
  for (const [k, m] of Object.entries(STATUS)) expect(m.label.length * 7 + 50, k).toBeLessThan(343);
  expect(Math.max(...Object.values(STATUS).map((m) => m.label.length))).toBeLessThanOrEqual(12);
});

it("formats rand", () => {
  expect(formatZar(95000)).toBe("R 950,00");
  expect(formatZar(123450)).toBe("R 1 234,50");
  expect(formatZar(5)).toBe("R 0,05");
  expect(formatZar(-100)).toBe("-R 1,00");
});

it("navigation is filtered by role", () => {
  const labels = (r: Parameters<typeof staffNav>[0]) => staffNav(r).map((i) => i.label);
  expect(labels("bookkeeper")).toEqual(["Billing", "Reports"]);
  expect(labels("psychologist")).not.toContain("Settings");
  expect(labels("psychologist")).toEqual(["Dashboard", "Calendar", "Patients", "Tasks", "Billing", "Claims", "Reports", "Audit log"]);
  expect(labels("admin")).toEqual(["Dashboard", "Calendar", "Patients", "Tasks", "Billing", "Claims", "Reports"]);
  expect(labels("bookkeeper")).not.toContain("Dashboard");
  expect(labels("bookkeeper")).not.toContain("Tasks");
  expect(labels("associate")).toEqual([]);
  for (const r of ["psychologist", "admin", "bookkeeper"] as const) expect(labels(r)).toContain("Reports");
  expect(labels("psychologist")).toContain("Audit log");
  expect(labels("admin")).not.toContain("Audit log");
  expect(labels("admin")).toContain("Patients");
  expect(labels("associate")).not.toContain("Billing");
  expect(labels("associate")).not.toContain("Patients"); // those pages 404 for associates in Phase 1
  expect(labels("associate")).not.toContain("Calendar");
  expect(staffPhoneNav("psychologist").map((i) => i.label)).toEqual(["Dashboard", "Calendar", "Patients", "Tasks", "More"]);
  expect(staffPhoneNav("bookkeeper").map((i) => i.label)).toEqual(["Billing", "Reports", "More"]);
  expect(portalNav().map((i) => i.label)).toEqual(["Home", "Appointments", "Documents", "Payments"]);
});
