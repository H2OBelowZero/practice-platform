import type { SupabaseClient } from "@supabase/supabase-js";
import { checkSchema, type FormSchema } from "./validate";

/** Columns read from form_submissions with its template (never `select *`). */
export const SUBMISSION_COLUMNS =
  "id, patient_id, template_id, template_version, status, answers, return_note, submitted_at, submitted_by, created_at, updated_at, form_templates(key, schema)";

export type SubmissionRow = {
  id: string; patient_id: string; template_id: string; template_version: number; status: "draft" | "submitted" | "returned";
  answers: Record<string, unknown>; return_note: string | null; submitted_at: string | null; submitted_by: string | null;
  created_at: string; updated_at: string; form_templates: { key: string; schema: FormSchema } | null;
};

export type LoadedSubmission = Omit<SubmissionRow, "form_templates"> & { key: string; schema: FormSchema };

/**
 * One submission with its template, through the CALLER'S client (RLS decides whether it is visible: someone else's, or an admin looking at
 * a restricted template, simply is not there). Null when missing or when the template's schema is unusable.
 */
export async function loadSubmission(sb: SupabaseClient, id: string): Promise<LoadedSubmission | null> {
  const { data } = await sb.from("form_submissions").select(SUBMISSION_COLUMNS).eq("id", id).maybeSingle();
  const row = data as unknown as SubmissionRow | null;
  if (!row?.form_templates || checkSchema(row.form_templates.schema).length > 0) return null;
  const { form_templates, ...rest } = row;
  return { ...rest, key: form_templates.key, schema: form_templates.schema };
}
