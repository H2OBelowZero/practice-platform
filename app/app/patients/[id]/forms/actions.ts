"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { patientEmail, safely } from "@/lib/appointments/followups";
import type { ActionState, Values } from "@/lib/appointments/types";
import { requireRole } from "@/lib/auth/session";
import { FORM_ERROR, formErrorText } from "@/lib/forms/errors";
import { patientIdSchema, requestSchema, returnNote, submissionId } from "@/lib/forms/input";
import { queueFormEmail } from "@/lib/forms/queue";
import { supabaseServer } from "@/lib/supabase/server";

// Staff form actions (psychologist and admin). Each calls requireRole first (R26), validates with Zod, and lets RLS decide: an admin can neither
// request nor return a restricted template's form (0012), whatever the page offered. Emails go to patients.email read through the staff user's own
// client, only when comms_prefs.email is true, with a payload of the portal link only.
const STAFF = ["psychologist", "admin"] as const;

/** Request a form: creates a draft for the patient (it appears in their Documents), queues an email, audits `form.request`. */
export async function requestForm(rawPatient: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const pid = patientIdSchema.safeParse(rawPatient), v = requestSchema.safeParse({ template: values.template });
  if (!pid.success) return { error: FORM_ERROR.missing };
  if (!v.success) return { error: "Choose a form to request." };
  const sb = await supabaseServer();

  const { data: patient } = await sb.from("patients").select("id, status, user_id").eq("id", pid.data).maybeSingle();
  if (!patient) return { error: "We could not find that patient." };
  if (patient.status === "archived") return { error: "This patient is archived. Restore them before requesting a form." };

  const { data: tpl } = await sb.from("form_templates").select("id, key, version, active").eq("id", v.data.template).maybeSingle();
  if (!tpl || !tpl.active) return { error: FORM_ERROR.unavailable };

  const { data: open } = await sb.from("form_submissions").select("id, form_templates!inner(key)")
    .eq("patient_id", pid.data).in("status", ["draft", "returned"]).eq("form_templates.key", tpl.key).limit(1);
  if (open?.length) return { error: "This form has already been requested and is waiting for the patient." };

  const { data, error } = await sb.from("form_submissions").insert({ patient_id: pid.data, template_id: tpl.id, template_version: tpl.version }).select("id").single();
  if (error || !data) return { error: /row-level security/.test(error?.message ?? "") ? "Only the psychologist can request this form." : formErrorText(error?.message) };

  const queued = await queueFormEmail("form_requested", await patientEmail(sb, pid.data), patient.user_id !== null);
  await safely("form.request", () => audit("form.request", "form_submissions", data.id as string, { patient_id: pid.data, template_key: tpl.key, template_version: tpl.version, email_queued: queued }));
  return redirect(`/app/patients/${pid.data}?tab=forms&notice=form_requested`);
}

/** Return a submitted form for correction with a note the patient will see. The form.return audit row is written by the database trigger. */
export async function returnForm(rawPatient: unknown, rawSubmission: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const pid = patientIdSchema.safeParse(rawPatient), sid = submissionId.safeParse(rawSubmission), note = returnNote.safeParse(values.note);
  if (!pid.success || !sid.success) return { error: FORM_ERROR.missing };
  if (!note.success) return { error: note.error.issues[0]?.message ?? "Write a short note for the patient." };
  const sb = await supabaseServer();

  const { data, error } = await sb.from("form_submissions").update({ status: "returned", return_note: note.data })
    .eq("id", sid.data).eq("patient_id", pid.data).eq("status", "submitted").select("id");
  if (error) return { error: formErrorText(error.message) };
  if (!data?.length) return { error: "Only a submitted form can be returned. It may already have been returned." };

  const { data: who } = await sb.from("patients").select("user_id").eq("id", pid.data).maybeSingle();
  await queueFormEmail("form_returned", await patientEmail(sb, pid.data), !!who?.user_id);
  return redirect(`/app/patients/${pid.data}?tab=forms&notice=form_returned`);
}
