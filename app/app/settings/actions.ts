"use server";

import { redirect } from "next/navigation";
import type { ActionState, Values } from "@/lib/appointments/types";
import { requireRole } from "@/lib/auth/session";
import { blockRange } from "@/lib/settings/blocks";
import { copyDay, isWeekday, validateDay, windowsFromValues, WEEKDAYS_MON_FRI } from "@/lib/settings/hours";
import { blockId, blockSchema, paymentSchema, practiceSchema, retentionSchema, sessionTypeId, sessionTypeSchema, settingsErrorText } from "@/lib/settings/input";
import { sectionHref } from "@/lib/settings/sections";
import { supabaseServer } from "@/lib/supabase/server";

// Settings actions. Each one calls requireRole itself (R26; requireRole also demands a multi-factor (aal2) session from every staff role), validates with Zod, and writes
// through the signed-in user's OWN client, so RLS decides again: only the psychologist may change settings, and blocked time is the admin's as well.
// AUDIT: there is no audit() call here on purpose. The database trigger settings_audit() (0027) records every row change by field NAMES, whoever or whatever made it,
// so a change made in the SQL editor is recorded too and no code path can forget. Nothing is emailed for any settings change.
const WRITER = ["psychologist"] as const;
const BLOCKERS = ["psychologist", "admin"] as const;
const SAVE_FAILED: NonNullable<ActionState> = { error: "We could not save that. Please try again." };
const NOT_FOUND: NonNullable<ActionState> = { error: "We could not find that. It may have been removed. Refresh the page and try again." };
const firstIssue = (e: { issues: { message: string; path: PropertyKey[] }[] }): NonNullable<ActionState> =>
  ({ error: e.issues[0]?.message ?? "Please check the details and try again.", field: String(e.issues[0]?.path[0] ?? "") || undefined });

/** Practice details, cancellation policy, approval mode, VAT and the crisis text. Payment instructions are a separate action on purpose. */
export async function updatePractice(values: Values): Promise<ActionState> {
  await requireRole([...WRITER]);
  const v = practiceSchema.safeParse(values);
  if (!v.success) return firstIssue(v.error);
  const sb = await supabaseServer();
  const { data: cur } = await sb.from("practices").select("id").limit(1).maybeSingle();
  if (!cur) return NOT_FOUND;
  const { data, error } = await sb.from("practices").update({
    name: v.data.name, registration_no: v.data.registrationNo ?? null, hpcsa_no: v.data.hpcsaNo ?? null, approval_mode: v.data.approvalMode,
    cancellation_window_hours: v.data.cancellationWindowHours, late_cancel_fee_cents: v.data.lateCancelFee,
    vat_registered: v.data.vatRegistered, vat_rate: v.data.vatRate, crisis_text: v.data.crisisText,
  }).eq("id", cur.id as string).select("id");
  if (error) return { error: settingsErrorText(error) };
  if (!data?.length) return SAVE_FAILED;
  return redirect(sectionHref("practice", "practice_saved"));
}

/**
 * The EFT details patients see (R41). Its own action, form and audit flag: criminals change bank details to redirect payments. The checkbox is checked here too;
 * the trigger records the field NAME (never the text) twice, as 'settings.change' and as 'settings.payment_instructions'.
 */
export async function updatePaymentInstructions(values: Values): Promise<ActionState> {
  await requireRole([...WRITER]);
  const v = paymentSchema.safeParse(values);
  if (!v.success) return firstIssue(v.error);
  const sb = await supabaseServer();
  const { data: cur } = await sb.from("practices").select("id").limit(1).maybeSingle();
  if (!cur) return NOT_FOUND;
  const { data, error } = await sb.from("practices").update({ payment_instructions: v.data.paymentInstructions }).eq("id", cur.id as string).select("id");
  if (error) return { error: settingsErrorText(error) };
  if (!data?.length) return SAVE_FAILED;
  return redirect(sectionHref("payment", "payment_saved"));
}

/** Add a session type. Deposits are not charged in Phase 1, so deposit_cents keeps its default of 0. */
export async function createSessionType(values: Values): Promise<ActionState> {
  await requireRole([...WRITER]);
  const v = sessionTypeSchema.safeParse(values);
  if (!v.success) return firstIssue(v.error);
  const sb = await supabaseServer();
  const { data, error } = await sb.from("session_types").insert({
    name: v.data.name, duration_min: v.data.durationMin, fee_cents: v.data.fee, format: v.data.format, buffer_min: v.data.bufferMin, active: v.data.active,
  }).select("id");
  if (error) return { error: settingsErrorText(error) };
  if (!data?.length) return SAVE_FAILED;
  return redirect(sectionHref("session-types", "type_added"));
}

/** Change a session type, including switching it off. There is no delete: appointments and invoices refer to session types, so a type is deactivated instead. */
export async function updateSessionType(rawId: unknown, values: Values): Promise<ActionState> {
  await requireRole([...WRITER]);
  const id = sessionTypeId.safeParse(rawId);
  if (!id.success) return NOT_FOUND;
  const v = sessionTypeSchema.safeParse(values);
  if (!v.success) return firstIssue(v.error);
  const sb = await supabaseServer();
  const { data, error } = await sb.from("session_types").update({
    name: v.data.name, duration_min: v.data.durationMin, fee_cents: v.data.fee, format: v.data.format, buffer_min: v.data.bufferMin, active: v.data.active,
  }).eq("id", id.data).select("id");
  if (error) return { error: settingsErrorText(error) };
  if (!data?.length) return NOT_FOUND;
  return redirect(sectionHref("session-types", "type_saved"));
}

/** Replace one weekday's windows in one transaction (set_day_availability). Only future bookings are affected; appointments already made stay as they are. */
export async function saveDay(rawWeekday: unknown, values: Values): Promise<ActionState> {
  await requireRole([...WRITER]);
  const weekday = Number(rawWeekday);
  if (!isWeekday(weekday)) return NOT_FOUND;
  const day = validateDay(windowsFromValues(values));
  if (!day.ok) return { error: day.error };
  const sb = await supabaseServer();
  const { error } = await sb.rpc("set_day_availability", { p_weekday: weekday, p_windows: day.windows });
  if (error) return { error: settingsErrorText(error) };
  return redirect(sectionHref("hours", "hours_saved"));
}

/** Copy Monday's SAVED hours to Tuesday-Friday (one atomic replacement per day). Refuses when Monday is closed, so it can never close the whole week by accident. */
export async function copyMondayToWeekdays(): Promise<ActionState> {
  await requireRole([...WRITER]);
  const sb = await supabaseServer();
  const { data, error: readError } = await sb.from("availability_rules").select("start_time, end_time").eq("weekday", 1).order("start_time");
  if (readError) return SAVE_FAILED;
  const monday = (data ?? []).map((r) => ({ start: String(r.start_time).slice(0, 5), end: String(r.end_time).slice(0, 5) }));
  if (!monday.length) return { error: "Monday has no saved hours to copy. Save Monday's hours first." };
  const copies = copyDay(monday, WEEKDAYS_MON_FRI.filter((d) => d !== 1));
  for (const [day, windows] of Object.entries(copies)) {
    const { error } = await sb.rpc("set_day_availability", { p_weekday: Number(day), p_windows: windows });
    if (error) return { error: `${settingsErrorText(error)} Some days may already be copied; check the week below.` };
  }
  return redirect(sectionHref("hours", "hours_copied"));
}

/** Add blocked time or leave (SAST wall-clock times). Overlapping appointments are counted and reported but never touched. */
export async function addBlock(values: Values): Promise<ActionState> {
  await requireRole([...BLOCKERS]);
  const v = blockSchema.safeParse(values);
  if (!v.success) return firstIssue(v.error);
  const range = blockRange(v.data.starts, v.data.ends, new Date());
  if (!range.ok) return { error: range.error, field: range.field };
  const sb = await supabaseServer();
  const { data, error } = await sb.from("blocked_times").insert({ starts_at: range.value.startsAt, ends_at: range.value.endsAt, reason: v.data.reason ?? null }).select("id");
  if (error) return { error: settingsErrorText(error) };
  if (!data?.length) return SAVE_FAILED;
  const { count } = await sb.from("appointments").select("id", { count: "exact", head: true })
    .in("status", ["tentative", "confirmed"]).lt("starts_at", range.value.endsAt).gt("ends_at", range.value.startsAt);
  return redirect(`${sectionHref("blocked", "block_added")}${count ? `&clash=${Math.min(count, 999)}` : ""}`);
}

export async function removeBlock(rawId: unknown): Promise<ActionState> {
  await requireRole([...BLOCKERS]);
  const id = blockId.safeParse(rawId);
  if (!id.success) return NOT_FOUND;
  const sb = await supabaseServer();
  const { data, error } = await sb.from("blocked_times").delete().eq("id", id.data).select("id");
  if (error) return { error: settingsErrorText(error) };
  if (!data?.length) return NOT_FOUND;
  return redirect(sectionHref("blocked", "block_removed"));
}

/** Years to keep (empty = indefinitely) and the legal hold of one record type. Informational only: nothing is deleted automatically in Phase 1. */
export async function updateRetention(rawType: unknown, values: Values): Promise<ActionState> {
  await requireRole([...WRITER]);
  const v = retentionSchema.safeParse({ ...values, recordType: rawType });
  if (!v.success) return firstIssue(v.error);
  const sb = await supabaseServer();
  const { data, error } = await sb.from("retention_policies").update({ retain_years: v.data.retainYears ?? null, legal_hold: v.data.legalHold }).eq("record_type", v.data.recordType).select("record_type");
  if (error) return { error: settingsErrorText(error) };
  if (!data?.length) return NOT_FOUND;
  return redirect(sectionHref("retention", "retention_saved"));
}
