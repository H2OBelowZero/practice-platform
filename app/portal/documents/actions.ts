"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import type { ActionState } from "@/lib/appointments/types";
import { consentPurposesFrom } from "@/lib/forms/consent";
import { draftAnswers } from "@/lib/forms/draft";
import { FORM_ERROR, formErrorText } from "@/lib/forms/errors";
import { answersSchema, seenSchema, startSchema, submissionId } from "@/lib/forms/input";
import { loadSubmission } from "@/lib/forms/load";
import { validateAnswers } from "@/lib/forms/validate";
import { supabaseServer } from "@/lib/supabase/server";

// Patient and guardian form actions. Each calls requireRole itself (R26), validates with Zod, and then lets RLS, the fs_guard trigger and
// submit_form() (0012) decide, all through the caller's own Supabase client. Nothing here uses the service client.
const PORTAL = ["patient", "guardian"] as const;

export type SaveResult = { ok: true; at: string } | { ok: false; error: string; conflict?: true };
/** Submit either redirects (success) or comes back with a message and one message per failing field. */
export type SubmitResult = { ok: false; error: string; errors: Record<string, string> };

/** Start a form for yourself or, as a guardian, for the person you care for. Opens an existing unfinished one instead of making a second. */
export async function startForm(rawPatient: unknown, rawTemplate: unknown): Promise<ActionState> {
  await requireRole([...PORTAL]);
  const v = startSchema.safeParse({ patientId: rawPatient, templateId: rawTemplate });
  if (!v.success) return { error: FORM_ERROR.invalid };
  const sb = await supabaseServer();

  const { data: tpl } = await sb.from("form_templates").select("id, key, version, active").eq("id", v.data.templateId).maybeSingle();
  if (!tpl || !tpl.active) return { error: FORM_ERROR.unavailable };

  const { data: open } = await sb.from("form_submissions").select("id, form_templates!inner(key)")
    .eq("patient_id", v.data.patientId).in("status", ["draft", "returned"]).eq("form_templates.key", tpl.key).limit(1);
  if (open?.[0]) redirect(`/portal/documents/${open[0].id as string}`);

  // template_version is set by the database from the template; RLS only lets you start a form for someone you may act for
  const { data, error } = await sb.from("form_submissions").insert({ patient_id: v.data.patientId, template_id: tpl.id, template_version: tpl.version }).select("id").single();
  if (error || !data) return { error: formErrorText(error?.message) };
  return redirect(`/portal/documents/${data.id as string}`);
}

/**
 * Autosave. The answers are sanitised against the template first (only its own keys, right types, nothing required), then written with a
 * plain update that RLS limits to draft and returned forms. A submitted form cannot be changed (zero rows come back).
 */
export async function saveDraft(rawId: unknown, rawAnswers: unknown, rawSeen: unknown): Promise<SaveResult> {
  await requireRole([...PORTAL]);
  const id = submissionId.safeParse(rawId), answers = answersSchema.safeParse(rawAnswers), seen = seenSchema.safeParse(rawSeen);
  if (!id.success || !answers.success || !seen.success) return { ok: false, error: FORM_ERROR.invalid };
  const sb = await supabaseServer();

  const sub = await loadSubmission(sb, id.data);
  if (!sub) return { ok: false, error: FORM_ERROR.missing };
  if (sub.status === "submitted") return { ok: false, error: FORM_ERROR.closed };

  // optimistic concurrency: only overwrite the version this editor last saw or loaded (another tab or device may have saved since)
  const { data, error } = await sb.from("form_submissions").update({ answers: draftAnswers(sub.schema, answers.data) })
    .eq("id", sub.id).eq("updated_at", seen.data).in("status", ["draft", "returned"]).select("updated_at");
  if (error) return { ok: false, error: formErrorText(error.message) };
  if (!data?.length) {
    const now = await loadSubmission(sb, sub.id);
    if (now && now.status !== "submitted" && now.updated_at !== seen.data) return { ok: false, error: FORM_ERROR.conflict, conflict: true };
    return { ok: false, error: FORM_ERROR.closed };
  }
  return { ok: true, at: data[0].updated_at as string };
}

/**
 * Submit. The full validation runs here (required fields, types, choices), then submit_form() does the status change, the snapshot, the audit
 * row and every consent in one transaction. The consent purposes come from the TICKED consent checkboxes of the validated answers; the database
 * re-checks them against the template. Success redirects to the list.
 */
export async function submitForm(rawId: unknown, rawAnswers: unknown): Promise<SubmitResult> {
  await requireRole([...PORTAL]);
  const id = submissionId.safeParse(rawId), answers = answersSchema.safeParse(rawAnswers);
  if (!id.success || !answers.success) return { ok: false, error: FORM_ERROR.invalid, errors: {} };
  const sb = await supabaseServer();

  const sub = await loadSubmission(sb, id.data);
  if (!sub) return { ok: false, error: FORM_ERROR.missing, errors: {} };
  if (sub.status === "submitted") return { ok: false, error: FORM_ERROR.closed, errors: {} };

  const result = validateAnswers(sub.schema, answers.data);
  if (!result.ok) return { ok: false, error: FORM_ERROR.fix, errors: result.errors };

  const { error } = await sb.rpc("submit_form", { p_submission: sub.id, p_answers: result.clean, p_consent_purposes: consentPurposesFrom(sub.schema, result.clean) });
  if (error) return { ok: false, error: formErrorText(error.message), errors: {} };
  return redirect("/portal/documents?notice=submitted");
}
