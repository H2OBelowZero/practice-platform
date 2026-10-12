import type { ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "@/lib/auth/roles";
import type { PatientRecord } from "@/lib/patients/record";
import { AdministrativeTab } from "./tab-administrative";
import { AuditTab } from "./tab-audit";
import { FormsTab } from "./tab-forms";
import { ProfileTab } from "./tab-profile";

/** What every tab gets. `query` is the page's search parameters (a tab reads its own, e.g. `confirm` or `apage`). */
export type TabContext = { patient: PatientRecord; role: Role; sb: SupabaseClient; query: Record<string, string | undefined>; today: string };

/**
 * The patient record's tabs. Later tasks add theirs here (Notes T12, Billing T13, Medical aid T14; Consent & forms is here): one entry each,
 * with the roles that may see it. The page shows only the tabs the signed-in role is listed for, and a tab the role is not listed for
 * falls back to the first one. A tab's data access still goes through RLS; this list hides, the database decides.
 */
export type PatientTab = { key: string; label: string; roles: Role[]; render: (ctx: TabContext) => ReactNode | Promise<ReactNode> };

export const PATIENT_TABS: PatientTab[] = [
  { key: "profile", label: "Profile", roles: ["psychologist", "admin"], render: ProfileTab },
  { key: "administrative", label: "Administrative", roles: ["psychologist", "admin"], render: AdministrativeTab },
  { key: "forms", label: "Consent & forms", roles: ["psychologist", "admin"], render: FormsTab },
  { key: "audit", label: "Audit", roles: ["psychologist"], render: AuditTab },
];

export const tabsFor = (role: Role): PatientTab[] => PATIENT_TABS.filter((t) => t.roles.includes(role));

/** The requested tab if this role may see it, else the first tab this role may see (undefined when it may see none). */
export const pickTab = (role: Role, key: string | undefined): PatientTab | undefined => {
  const mine = tabsFor(role);
  return mine.find((t) => t.key === key) ?? mine[0];
};
