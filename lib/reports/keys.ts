import { z } from "zod";
import type { Role } from "@/lib/auth/roles";
import { rangeProblem } from "./periods";

// Which role may see which report, once, for the page, the tabs and the CSV route. The database enforces the same matrix (0025 role guards); this list hides
// and refuses early, the database decides.

export const REPORT_ROLES: Role[] = ["psychologist", "admin", "bookkeeper"];

export const TABS = [
  { key: "financial", label: "Financial", roles: ["psychologist", "admin", "bookkeeper"] },
  { key: "appointments", label: "Appointments", roles: ["psychologist", "admin"] },
  { key: "activity", label: "Practice activity", roles: ["psychologist", "admin"] },
  { key: "compliance", label: "Compliance", roles: ["psychologist"] },
] as const satisfies readonly { key: string; label: string; roles: readonly Role[] }[];
export type ReportTab = (typeof TABS)[number]["key"];

export const tabsFor = (role: Role) => TABS.filter((t) => (t.roles as readonly Role[]).includes(role));

/** The tab to show: the one asked for when this role may see it, else the first this role may see (a bookkeeper asking for compliance gets Financial). */
export function parseTab(value: string | undefined, role: Role): ReportTab {
  const mine = tabsFor(role);
  return (mine.find((t) => t.key === value) ?? mine[0]).key;
}

export const EXPORT_KEYS = ["income_by_month", "income_by_method", "income_by_session_type", "debtors", "appointments", "activity", "compliance", "transactions"] as const;
export type ExportKey = (typeof EXPORT_KEYS)[number];

const FINANCIAL: Role[] = ["psychologist", "admin", "bookkeeper"], STAFF: Role[] = ["psychologist", "admin"];
export const EXPORT_ROLES: Record<ExportKey, Role[]> = {
  income_by_month: FINANCIAL, income_by_method: FINANCIAL, income_by_session_type: FINANCIAL, debtors: FINANCIAL, transactions: FINANCIAL,
  appointments: STAFF, activity: STAFF, compliance: ["psychologist"],
};
export const canExport = (role: Role, key: ExportKey): boolean => EXPORT_ROLES[key].includes(role);

export const EXPORT_LABEL: Record<ExportKey, string> = {
  income_by_month: "Income by month", income_by_method: "Income by payment method", income_by_session_type: "Income by session type", debtors: "Debtors",
  appointments: "Appointments", activity: "Practice activity", compliance: "Compliance", transactions: "Accountant export (transactions)",
};

/** The query string of a CSV export: a whitelisted report key and a usable pair of dates. Anything else is a failed parse. */
export const exportQuery = z.object({
  report: z.enum(EXPORT_KEYS),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).refine((q) => rangeProblem(q.from, q.to) === null);
