import type { Role } from "@/lib/auth/roles";

/** The settings sections, in the order of the tab bar. `?section=` selects one; anything else is the first. */
export const SECTIONS = [
  { key: "practice", label: "Practice details" },
  { key: "payment", label: "Payment instructions" },
  { key: "session-types", label: "Session types" },
  { key: "hours", label: "Working hours" },
  { key: "blocked", label: "Blocked time and leave" },
  { key: "retention", label: "Record retention" },
  { key: "information", label: "Templates, staff and connections" },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];

export const parseSection = (s: string | undefined): SectionKey => SECTIONS.find((x) => x.key === s)?.key ?? "practice";
export const sectionHref = (key: SectionKey, notice?: string): string => `/app/settings?section=${key}${notice ? `&notice=${notice}` : ""}`;

/** Only the practitioner changes settings. The admin (the receptionist) may manage blocked time and leave, and nothing else (RLS agrees). */
export const SETTINGS_WRITER: Role = "psychologist";
/** What the admin can see (and do) in each section: said honestly, because retention policies and the audit log are hidden from the admin by RLS. */
export const adminSeesText = (key: SectionKey): string => ({
  practice: "You can see all the practice details here.",
  payment: "You can read the payment instructions that patients see, but not change them.",
  "session-types": "You can see the session types, but not change them.",
  hours: "You can see the working hours, but not change them.",
  blocked: "You can add and remove blocked time and leave.",
  retention: "Retention settings are visible to the practitioner only.",
  information: "You can see the templates, staff and connections; the last scheduled run is visible to the practitioner only.",
} satisfies Record<SectionKey, string>)[key];
export const READ_ONLY_TEXT = "Only the practitioner can change settings";
export const canEditSection = (role: Role, key: SectionKey): boolean => role === "psychologist" || (role === "admin" && key === "blocked");

/** What the retention table calls each record type (the keys seeded by 0027); an unknown key is shown as it is. */
export const RETENTION_LABEL: Record<string, { label: string; help: string }> = {
  clinical_notes: { label: "Clinical notes", help: "Session notes, addenda and their saved versions." },
  forms_consents: { label: "Forms and consents", help: "Intake forms, signed consents and withdrawals." },
  financial_records: { label: "Financial records", help: "Invoices, payments, credit notes, claims and remittances." },
  audit_log: { label: "Audit log", help: "The record of who looked at or changed what." },
  communications: { label: "Communications", help: "Emails and messages the platform sent." },
};
export const RETENTION_ORDER = Object.keys(RETENTION_LABEL);
export const retentionLabel = (key: string): { label: string; help: string } => RETENTION_LABEL[key] ?? { label: key, help: "" };
export const retentionSummary = (years: number | null, hold: boolean): string =>
  `${years === null ? "Kept indefinitely" : `Keep for ${years} ${years === 1 ? "year" : "years"}`}${hold ? ", legal hold on" : ""}`;

export function sortRetention<T extends { record_type: string }>(rows: T[]): T[] {
  const rank = (k: string) => { const i = RETENTION_ORDER.indexOf(k); return i < 0 ? RETENTION_ORDER.length : i; };
  return [...rows].sort((a, b) => rank(a.record_type) - rank(b.record_type) || a.record_type.localeCompare(b.record_type));
}

export const NOTICES: Record<string, string> = {
  practice_saved: "The practice details are saved.",
  payment_saved: "The payment instructions are saved. This change was recorded in the audit log.",
  type_added: "The session type is added.",
  type_saved: "The session type is saved.",
  hours_saved: "The working hours are saved. They apply to future bookings only; appointments already booked are not changed.",
  hours_copied: "Monday's hours are copied to Tuesday to Friday. They apply to future bookings only.",
  block_added: "The block is added.",
  block_removed: "The block is removed.",
  retention_saved: "The retention setting is saved.",
};
export const settingsNotice = (s: string | undefined): string | null => (s && Object.hasOwn(NOTICES, s) ? NOTICES[s] : null);

export const ROLE_LABEL: Record<string, string> = {
  psychologist: "Psychologist", admin: "Admin", bookkeeper: "Bookkeeper", associate: "Associate",
};
