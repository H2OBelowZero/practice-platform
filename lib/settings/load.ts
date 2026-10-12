import type { SupabaseClient } from "@supabase/supabase-js";
import { consentFields } from "@/lib/forms/consent";
import type { FormSchema } from "@/lib/forms/validate";
import { overlapCount } from "./blocks";
import { windowsByWeekday, type Win } from "./hours";
import { cronRunFrom, type CronRun } from "./env-status";

// Reads for the settings page. Everything goes through the signed-in user's own client, so RLS decides what comes back (the admin gets no retention rows and no audit rows).
// Columns are always listed. profiles is read for display_name and role only (never an email), and only for staff roles.
export type PracticeRow = {
  id: string; name: string; registration_no: string | null; hpcsa_no: string | null; approval_mode: "auto" | "request";
  cancellation_window_hours: number; late_cancel_fee_cents: number; vat_registered: boolean; vat_rate: number | string; crisis_text: string;
};
export type SessionTypeRow = { id: string; name: string; duration_min: number; fee_cents: number; format: string; buffer_min: number; active: boolean };
export type BlockRow = { id: string; starts_at: string; ends_at: string; reason: string | null; clashes: number };
export type RetentionRow = { record_type: string; retain_years: number | null; legal_hold: boolean };
export type TemplateRow = { key: string; version: number; active: boolean; restricted: boolean; purposes: string[] };
export type StaffRow = { display_name: string; role: string };

export async function loadPractice(sb: SupabaseClient): Promise<{ practice: PracticeRow | null; failed: boolean }> {
  const { data, error } = await sb.from("practices")
    .select("id, name, registration_no, hpcsa_no, approval_mode, cancellation_window_hours, late_cancel_fee_cents, vat_registered, vat_rate, crisis_text").limit(1).maybeSingle();
  return { practice: (data as PracticeRow | null) ?? null, failed: !!error };
}

/** Read apart from the other practice fields so that only the sections that show it ever load it. */
export async function loadPaymentInstructions(sb: SupabaseClient): Promise<string | null> {
  const { data } = await sb.from("practices").select("payment_instructions").limit(1).maybeSingle();
  return (data as { payment_instructions: string } | null)?.payment_instructions ?? null;
}

export async function loadSessionTypes(sb: SupabaseClient): Promise<{ rows: SessionTypeRow[]; failed: boolean }> {
  const { data, error } = await sb.from("session_types").select("id, name, duration_min, fee_cents, format, buffer_min, active").order("active", { ascending: false }).order("name");
  return { rows: (data ?? []) as SessionTypeRow[], failed: !!error };
}

export async function loadHours(sb: SupabaseClient): Promise<{ days: Record<number, Win[]>; failed: boolean }> {
  const { data, error } = await sb.from("availability_rules").select("weekday, start_time, end_time").order("weekday").order("start_time");
  return { days: windowsByWeekday((data ?? []) as { weekday: number; start_time: string; end_time: string }[]), failed: !!error };
}

/** Blocks that have not ended yet (soonest first, at most 100), each with the number of confirmed or requested appointments inside it. */
export async function loadBlocks(sb: SupabaseClient, now: Date): Promise<{ rows: BlockRow[]; failed: boolean }> {
  const { data, error } = await sb.from("blocked_times").select("id, starts_at, ends_at, reason").gt("ends_at", now.toISOString()).order("starts_at").limit(100);
  const blocks = (data ?? []) as Omit<BlockRow, "clashes">[];
  if (!blocks.length) return { rows: [], failed: !!error };
  const from = blocks.reduce((m, b) => (b.starts_at < m ? b.starts_at : m), blocks[0].starts_at);
  const to = blocks.reduce((m, b) => (b.ends_at > m ? b.ends_at : m), blocks[0].ends_at);
  const { data: appts } = await sb.from("appointments").select("starts_at, ends_at").in("status", ["tentative", "confirmed"]).lt("starts_at", to).gt("ends_at", from).limit(1000);
  const spans = (appts ?? []) as { starts_at: string; ends_at: string }[];
  return { rows: blocks.map((b) => ({ ...b, clashes: overlapCount(b, spans) })), failed: !!error };
}

export async function loadRetention(sb: SupabaseClient): Promise<{ rows: RetentionRow[]; failed: boolean }> {
  const { data, error } = await sb.from("retention_policies").select("record_type, retain_years, legal_hold").order("record_type");
  return { rows: (data ?? []) as RetentionRow[], failed: !!error };
}

export async function loadTemplates(sb: SupabaseClient): Promise<{ rows: TemplateRow[]; failed: boolean }> {
  const { data, error } = await sb.from("form_templates").select("key, version, active, schema").order("key").order("version", { ascending: false });
  const rows = ((data ?? []) as { key: string; version: number; active: boolean; schema: FormSchema | null }[]).map((t) => ({
    key: t.key, version: t.version, active: t.active, restricted: t.schema?.restricted === true,
    purposes: [...new Set(Array.isArray(t.schema?.fields) ? consentFields(t.schema as FormSchema).map((f) => String(f.consentPurpose)) : [])],
  }));
  return { rows, failed: !!error };
}

export async function loadStaff(sb: SupabaseClient): Promise<{ rows: StaffRow[]; failed: boolean }> {
  const { data, error } = await sb.from("profiles").select("display_name, role").in("role", ["psychologist", "admin", "bookkeeper", "associate"]).order("display_name");
  return { rows: (data ?? []) as StaffRow[], failed: !!error };
}

/** Last cron run (audit row, psychologist only: RLS hides audit_log from everyone else) and the open "notification could not be sent" tasks. */
export async function loadHealth(sb: SupabaseClient, canReadAudit: boolean): Promise<{ cron: CronRun; cronVisible: boolean; failedNotifications: number | null }> {
  let cron: CronRun = null;
  if (canReadAudit) {
    const { data } = await sb.from("audit_log").select("at, detail").eq("action", "cron.reminders.run").order("at", { ascending: false }).limit(1).maybeSingle();
    cron = cronRunFrom(data as { at: string; detail: unknown } | null);
  }
  const { count, error } = await sb.from("tasks").select("id", { count: "exact", head: true }).like("source", "outbox_failed:%").eq("status", "open");
  return { cron, cronVisible: canReadAudit, failedNotifications: error ? null : (count ?? 0) };
}
