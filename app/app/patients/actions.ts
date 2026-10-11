"use server";

import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/app-url";
import { audit } from "@/lib/audit";
import { safely } from "@/lib/appointments/followups";
import type { ActionState, Values } from "@/lib/appointments/types";
import { requireRole } from "@/lib/auth/session";
import { ageOn } from "@/lib/patients/age";
import type { DuplicateMatch } from "@/lib/patients/duplicates";
import { duplicateConfirmed, duplicateFingerprint } from "@/lib/patients/fingerprint";
import { adminSchema, createSchema, emergencyContact, invalidState, patientId, profileSchema, restoreSchema } from "@/lib/patients/input";
import { inviteBlock, inviteErrorText, invitationVoidedByEmailChange } from "@/lib/patients/invite";
import type { PatientNoticeCode } from "@/lib/patients/notices";
import { lookupDuplicates, PATIENT_COLUMNS, type PatientRecord } from "@/lib/patients/record";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { sastDate } from "@/lib/time";

// Staff patient actions. Every one calls requireRole itself (R26), validates with Zod, lets RLS and the patients guard decide, then audits.
// Audit detail holds field NAMES only, never the values (no personal information in the audit log).
const STAFF = ["psychologist", "admin"] as const;
const SAVE_FAILED = "We could not save the changes. Please try again.";
const NOT_FOUND = "We could not find that patient.";

const firstIssue = (e: { issues: { message: string }[] }) => e.issues[0]?.message ?? "Please check the details and try again.";
const back = (id: string, tab: string, notice: PatientNoticeCode): never => redirect(`/app/patients/${id}?tab=${tab}&notice=${notice}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function load(rawId: unknown) {
  await requireRole([...STAFF]);
  const id = patientId.safeParse(rawId);
  if (!id.success) return null;
  const sb = await supabaseServer();
  const { data } = await sb.from("patients").select(PATIENT_COLUMNS).eq("id", id.data).maybeSingle();
  return { id: id.data, sb, patient: (data as PatientRecord | null) ?? null };
}

/**
 * What an edit form gets back when it stays on the page: a summary, one message per failing field (shown next to the input), the values
 * that were typed (so the form refills) and `at` (a new key remounts the form with those values). Success redirects instead.
 */
export type EditState = { error?: string; fieldErrors?: Record<string, string>; values: Values; at: number } | null;
const fail = (error: string, values: Values): EditState => ({ error, values, at: Date.now() });

/** The create form's state: either field errors, or the possible duplicates to confirm. `values` refills the form; `at` re-keys it. */
export type CreateState = (NonNullable<EditState> & { duplicates?: DuplicateMatch[]; fingerprint?: string }) | null;

export async function createPatient(values: Values): Promise<CreateState> {
  await requireRole([...STAFF]);
  const refill: Values = { ...values, confirmDuplicate: "", duplicateFingerprint: "" };
  const v = createSchema.safeParse(values);
  if (!v.success) return { ...invalidState(v.error, refill), at: Date.now() };
  const d = v.data;
  const sb = await supabaseServer();

  let duplicates: DuplicateMatch[];
  try {
    duplicates = await lookupDuplicates(sb, { first_name: d.first_name, last_name: d.last_name, date_of_birth: d.date_of_birth ?? null, email: d.email ?? null, phone: d.phone ?? null });
  } catch {
    return fail("We could not check whether this patient already exists. Please try again.", refill);
  }
  // "Create anyway" only counts for the exact set of matches it was shown with; any other set warns again
  if (duplicates.length > 0 && !duplicateConfirmed(d.confirmDuplicate, values.duplicateFingerprint, duplicates))
    return { duplicates, fingerprint: duplicateFingerprint(duplicates), values: refill, at: Date.now() };

  const age = ageOn(d.date_of_birth, sastDate(new Date()));
  const { data, error } = await sb.from("patients").insert({
    first_name: d.first_name, last_name: d.last_name, date_of_birth: d.date_of_birth ?? null, email: d.email ?? null, phone: d.phone ?? null,
    language: d.language, comms_prefs: { email: d.comms_email, sms: d.comms_sms }, emergency_contact: emergencyContact(d), referral_source: d.referral_source ?? null,
    payer: d.payer, status: d.status, is_minor: age !== null && age < 18,
  }).select("id").single();
  if (error || !data) return fail(SAVE_FAILED, refill);

  await safely("patient.create", () => audit("patient.create", "patients", data.id as string, { status: d.status, duplicate_confirmed: duplicates.length > 0 }));
  return back(data.id as string, "profile", "created");
}

/** Apply `patch` to a patient, audit the changed field names, and go back to the tab. */
async function applyChanges(id: string, sb: SupabaseClient, patch: Record<string, unknown>, tab: string, values: Values, notice: PatientNoticeCode = "saved"): Promise<EditState> {
  const fields = Object.keys(patch);
  if (fields.length === 0) return back(id, tab, "unchanged");
  const { data, error } = await sb.from("patients").update(patch).eq("id", id).select("id");
  if (error || !data?.length) return fail(SAVE_FAILED, values);
  await safely("patient.update", () => audit("patient.update", "patients", id, { fields }));
  return back(id, tab, notice);
}

export async function updateProfile(rawId: unknown, values: Values): Promise<EditState> {
  const ctx = await load(rawId);
  const v = profileSchema.safeParse(values);
  if (!ctx?.patient) return fail(NOT_FOUND, values);
  if (!v.success) return { ...invalidState(v.error, values), at: Date.now() };
  const { id, sb, patient: p } = ctx, d = v.data;

  const next = { first_name: d.first_name, last_name: d.last_name, date_of_birth: d.date_of_birth ?? null, email: d.email ?? null, phone: d.phone ?? null, language: d.language,
    comms_prefs: { ...(p.comms_prefs ?? {}), email: d.comms_email, sms: d.comms_sms } };
  const patch: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(next)) if (!same(val, p[k as keyof PatientRecord])) patch[k] = val;
  // the minor flag follows the date of birth whenever a date is given (staff may still correct it in the database)
  if (patch.date_of_birth) {
    const minor = (ageOn(d.date_of_birth, sastDate(new Date())) ?? 99) < 18;
    if (minor !== p.is_minor) patch.is_minor = minor;
  }
  // a new email address cancels an earlier invitation that was sent to the old one (the account link needs the email to match the record)
  const voided = "email" in patch && invitationVoidedByEmailChange(p, d.email ?? null);
  if (voided) patch.portal_invited_at = null;
  return applyChanges(id, sb, patch, "profile", values, voided ? "saved_reinvite" : "saved");
}

export async function updateAdministrative(rawId: unknown, values: Values): Promise<EditState> {
  const ctx = await load(rawId);
  const v = adminSchema.safeParse(values);
  if (!ctx?.patient) return fail(NOT_FOUND, values);
  if (!v.success) return { ...invalidState(v.error, values), at: Date.now() };
  const { id, sb, patient: p } = ctx, d = v.data;

  const next: Record<string, unknown> = { emergency_contact: emergencyContact(d), referral_source: d.referral_source ?? null, payer: d.payer };
  if (d.status && p.status !== "archived") next.status = d.status; // archive and restore have their own confirmation
  const patch: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(next)) if (!same(val, p[k as keyof PatientRecord])) patch[k] = val;
  return applyChanges(id, sb, patch, "administrative", values);
}

/** Archive keeps the whole record (there is no delete). The confirmation panel on the page is the confirmation. */
export async function archivePatient(rawId: unknown): Promise<ActionState> {
  const ctx = await load(rawId);
  if (!ctx?.patient) return { error: NOT_FOUND };
  const { id, sb, patient: p } = ctx;
  if (p.status === "archived") return { error: "This patient is already archived." };
  const { data, error } = await sb.from("patients").update({ status: "archived" }).eq("id", id).neq("status", "archived").select("id");
  if (error || !data?.length) return { error: SAVE_FAILED };
  await safely("patient.archive", () => audit("patient.archive", "patients", id, { from: p.status }));
  return back(id, "administrative", "archived");
}

export async function restorePatient(rawId: unknown, values: Values): Promise<ActionState> {
  const ctx = await load(rawId);
  const v = restoreSchema.safeParse(values);
  if (!ctx?.patient) return { error: NOT_FOUND };
  if (!v.success) return { error: firstIssue(v.error) };
  const { id, sb, patient: p } = ctx;
  if (p.status !== "archived") return { error: "This patient is not archived." };
  const { data, error } = await sb.from("patients").update({ status: v.data.status }).eq("id", id).eq("status", "archived").select("id");
  if (error || !data?.length) return { error: SAVE_FAILED };
  await safely("patient.restore", () => audit("patient.restore", "patients", id, { to: v.data.status }));
  return back(id, "administrative", "restored");
}

/**
 * Invite a patient to the portal (R28). The database function invite_patient() (0011) checks the patient, enforces the 10 minute
 * throttle on the database clock and sets portal_invited_at (what lets their new account be linked to this record, see
 * ensure_patient_record in 0008). Then ONE email is queued; the payload is the registration link only: no name, no clinical detail.
 * If queueing fails, the previous portal_invited_at is put back, so the patient does not look invited and staff can retry at once.
 */
export async function invitePatient(rawId: unknown): Promise<ActionState> {
  const ctx = await load(rawId);
  if (!ctx?.patient) return { error: NOT_FOUND };
  const { id, sb, patient: p } = ctx;
  const block = inviteBlock(p, sastDate(new Date()));
  if (block || !p.email) return { error: block ?? "Add an email address on the Profile tab first." };

  // 1. mark the invitation (staff only, throttled, in the database)
  const marked = await sb.rpc("invite_patient", { p_patient: id });
  if (marked.error || !marked.data) return { error: inviteErrorText(marked.error?.message) };
  const stamp = marked.data as string;

  // 2. queue the email (the outbox is service-role only). The recipient is read from the record through RLS above, not from the form.
  const queued = await supabaseService().from("notifications_outbox").insert({
    channel: "email", template: "portal_invite", recipient: p.email, payload: { link: `${appUrl()}/register?next=/book` },
  });
  if (queued.error) {
    const undo = await sb.from("patients").update({ portal_invited_at: p.portal_invited_at }).eq("id", id).eq("portal_invited_at", stamp);
    return { error: undo.error
      ? "The invitation email could not be queued. Please wait 10 minutes and try again."
      : "The invitation email could not be queued, so nothing was sent. Please try again." };
  }

  await safely("patient.invite", () => audit("patient.invite", "patients", id, { email_queued: true }));
  return back(id, "profile", "invited");
}
