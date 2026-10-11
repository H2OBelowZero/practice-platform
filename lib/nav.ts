import type { Role } from "@/lib/auth/roles";
import type { IconName } from "@/components/ui/icon";

export type NavItem = { href: string; label: string; icon: IconName };
type Def = NavItem & { roles: Role[]; phone?: boolean };

const CLINICAL_ADMIN: Role[] = ["psychologist", "admin", "associate"];

// Calendar and Patients are psychologist/admin only (their pages 404 for everyone else; the associate UI is not exposed in Phase 1).
// Navigation is a convenience, never the control: every page and action still calls requireRole (R26).
// Clinical records are reached from a patient's page and only the psychologist may open them, so no admin/bookkeeper link points there.
const STAFF: Def[] = [
  { href: "/app", label: "Dashboard", icon: "home", roles: CLINICAL_ADMIN, phone: true },
  { href: "/app/calendar", label: "Calendar", icon: "calendar", roles: ["psychologist", "admin"], phone: true },
  { href: "/app/patients", label: "Patients", icon: "users", roles: ["psychologist", "admin"], phone: true },
  { href: "/app/tasks", label: "Tasks", icon: "tasks", roles: CLINICAL_ADMIN, phone: true },
  { href: "/app/billing", label: "Billing", icon: "card", roles: ["psychologist", "admin", "bookkeeper"], phone: true },
  { href: "/app/claims", label: "Claims", icon: "doc", roles: ["psychologist", "admin"] },
  { href: "/app/reports", label: "Reports", icon: "chart", roles: ["psychologist", "admin", "bookkeeper"], phone: true },
  { href: "/app/audit", label: "Audit log", icon: "shield", roles: ["psychologist"] },
  { href: "/app/settings", label: "Settings", icon: "gear", roles: ["psychologist", "admin"] },
];

const PORTAL: NavItem[] = [
  { href: "/portal", label: "Home", icon: "home" },
  { href: "/portal/appointments", label: "Appointments", icon: "calendar" },
  { href: "/portal/documents", label: "Documents", icon: "doc" },
  { href: "/portal/payments", label: "Payments", icon: "card" },
];

const strip = ({ href, label, icon }: Def): NavItem => ({ href, label, icon });

/** Every staff nav link this role may see (sidebar, and the "More" page on phones). */
export const staffNav = (role: Role): NavItem[] => STAFF.filter((i) => i.roles.includes(role)).map(strip);

/**
 * Phone bottom bar: up to four main items, then "More" (all links plus sign out).
 * Clinical staff get Dashboard, Calendar, Patients, Tasks; a bookkeeper only has Billing and Reports.
 */
export function staffPhoneNav(role: Role): NavItem[] {
  const mine = STAFF.filter((i) => i.roles.includes(role));
  const main = mine.filter((i) => i.phone);
  return [...(main.length ? main : mine).slice(0, 4).map(strip), { href: "/app/more", label: "More", icon: "more" }];
}

export const portalNav = (): NavItem[] => PORTAL;
