"use server";

import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { safely } from "@/lib/appointments/followups";
import type { ActionState, Values } from "@/lib/appointments/types";
import { isEmptyNote, sanitiseContent, sanitiseRisk, type NoteContent } from "@/lib/notes/content";
import { NOTE_ERROR, noteErrorText } from "@/lib/notes/errors";
import { addendumSchema, contentSchema, createSchema, noteId, patientIdSchema, riskSchema, versionId } from "@/lib/notes/input";
import { ensureRiskTask } from "@/lib/notes/risk-task";
import { templateKeys } from "@/lib/notes/templates";
import { supabaseServer } from "@/lib/supabase/server";

// Clinical note actions. The psychologist only: each one calls requireRole itself (R26), validates with Zod, and then lets RLS and the
// notes_guard trigger decide, all through the caller's own Supabase client (sign_note and add_addendum are security invoker).
// Nothing here logs, audits or redirects with note text: errors are fixed messages, audit details are ids, URLs hold ids and a notice code.
const PSY = ["psychologist"] as const;

export type SaveResult = { ok: true; at: string; taskFailed?: true } | { ok: false; error: string; closed?: true };
export type VersionResult = { ok: true; content: NoteContent } | { ok: false; error: string };

type NoteRow = {
  id: string; patient_id: string; appointment_id: string | null; state: string; content: unknown; risk: unknown;
  note_templates: { schema: unknown } | null;
};

async function loadNote(sb: SupabaseClient, id: string): Promise<NoteRow | null> {
  const { data } = await sb.from("clinical_notes").select("id, patient_id, appointment_id, state, content, risk, note_templates(schema)").eq("id", id).maybeSingle();
  return (data as unknown as NoteRow | null) ?? null;
}

/** Start a note. A draft is inserted with the caller's own client (RLS: author_id must be the caller; notes_guard: state draft). */
export async function createNote(rawPatient: unknown, values: Values): Promise<ActionState> {
  const me = await requireRole([...PSY]);
  const pid = patientIdSchema.safeParse(rawPatient), v = createSchema.safeParse(values);
  if (!pid.success || !v.success) return { error: NOTE_ERROR.invalid };
  const sb = await supabaseServer();

  const { data: patient } = await sb.from("patients").select("id").eq("id", pid.data).maybeSingle();
  if (!patient) return { error: NOTE_ERROR.missing };
  const { data: tpl } = await sb.from("note_templates").select("id, active").eq("id", v.data.template).maybeSingle();
  if (!tpl || tpl.active === false) return { error: NOTE_ERROR.template };

  const appointment = v.data.appointment;
  if (appointment) {
    // only this patient's attended or confirmed appointments may be linked (checked here, not just offered in the list)
    const { data: ok } = await sb.from("appointments").select("id").eq("id", appointment).eq("patient_id", pid.data).in("status", ["attended", "confirmed"]).maybeSingle();
    if (!ok) return { error: NOTE_ERROR.appointment };
    // one note per appointment from this screen: open the existing one instead of starting a second (also covers a double click)
    const { data: existing } = await sb.from("clinical_notes").select("id").eq("appointment_id", appointment).order("created_at").limit(1);
    if (existing?.[0]) return redirect(`/app/notes/${existing[0].id as string}`);
  }

  const { data, error } = await sb.from("clinical_notes")
    .insert({ patient_id: pid.data, appointment_id: appointment ?? null, template_id: tpl.id, author_id: me.userId, state: "draft" }).select("id").single();
  if (error || !data) return { error: noteErrorText(error?.message) };
  await safely("note.create", () => audit("note.create", "clinical_notes", data.id as string));
  return redirect(`/app/notes/${data.id as string}`);
}

/**
 * Autosave. Content and risk are cut down to the template's fields and the allowed levels, then written with a plain update limited to
 * `state = 'draft'` (a signed note comes back as zero rows and is reported as closed; the trigger would refuse it anyway). The database
 * keeps the previous content as a version. A moderate or high risk level raises the staff task (once per note and level).
 */
export async function saveNoteDraft(rawId: unknown, rawContent: unknown, rawRisk: unknown): Promise<SaveResult> {
  await requireRole([...PSY]);
  const id = noteId.safeParse(rawId), content = contentSchema.safeParse(rawContent), risk = riskSchema.safeParse(rawRisk);
  if (!id.success || !content.success || !risk.success) return { ok: false, error: NOTE_ERROR.invalid };
  const sb = await supabaseServer();

  const note = await loadNote(sb, id.data);
  if (!note) return { ok: false, error: NOTE_ERROR.missing };
  if (note.state !== "draft") return { ok: false, error: NOTE_ERROR.closed, closed: true };

  const clean = sanitiseContent(templateKeys(note.note_templates?.schema), content.data), cleanRisk = sanitiseRisk(risk.data);
  const { data, error } = await sb.from("clinical_notes").update({ content: clean, risk: cleanRisk }).eq("id", note.id).eq("state", "draft").select("id");
  if (error) { const text = noteErrorText(error.message); return { ok: false, error: text, ...(text === NOTE_ERROR.closed ? { closed: true as const } : {}) }; }
  if (!data?.length) return { ok: false, error: NOTE_ERROR.closed, closed: true };

  const taskOk = await ensureRiskTask(sb, note, cleanRisk);
  return { ok: true, at: new Date().toISOString(), ...(taskOk ? {} : { taskFailed: true as const }) };
}

/**
 * Sign. The client has saved its pending edits first; the stored draft is what gets signed. An empty note is refused, the risk task is made sure of
 * (so a flag is never signed away without its follow-up), then sign_note() flips the state: the author-only rule, signed_at and the audit row
 * (note.sign) are all inside the database. Success redirects to the read-only view.
 */
export async function signNote(rawId: unknown): Promise<ActionState> {
  await requireRole([...PSY]);
  const id = noteId.safeParse(rawId);
  if (!id.success) return { error: NOTE_ERROR.invalid };
  const sb = await supabaseServer();

  const note = await loadNote(sb, id.data);
  if (!note) return { error: NOTE_ERROR.missing };
  if (note.state !== "draft") return redirect(`/app/notes/${note.id}`); // already signed (a double click or a second tab)
  if (isEmptyNote(sanitiseContent(templateKeys(note.note_templates?.schema), note.content))) return { error: NOTE_ERROR.empty };
  if (!(await ensureRiskTask(sb, note, sanitiseRisk(note.risk)))) return { error: NOTE_ERROR.task };

  const { error } = await sb.rpc("sign_note", { p_note: note.id });
  if (error) return { error: noteErrorText(error.message) };
  return redirect(`/app/notes/${note.id}?notice=signed`);
}

/** Add an addendum to a signed note (the only way to correct it). add_addendum() inserts it as the caller, the database marks the note amended and audits it. */
export async function addAddendum(rawId: unknown, values: Values): Promise<ActionState> {
  await requireRole([...PSY]);
  const id = noteId.safeParse(rawId), v = addendumSchema.safeParse(values);
  if (!id.success) return { error: NOTE_ERROR.invalid };
  if (!v.success) return { error: v.error.issues[0]?.message ?? NOTE_ERROR.invalid };
  const sb = await supabaseServer();

  const { error } = await sb.rpc("add_addendum", { p_note: id.data, p_content: v.data.content });
  if (error) return { error: noteErrorText(error.message) };
  return redirect(`/app/notes/${id.data}?notice=addendum`);
}

/** The content of one earlier draft version, loaded only when the psychologist asks to see it (the page lists versions without their text). */
export async function loadNoteVersion(rawNote: unknown, rawVersion: unknown): Promise<VersionResult> {
  await requireRole([...PSY]);
  const id = noteId.safeParse(rawNote), ver = versionId.safeParse(rawVersion);
  if (!id.success || !ver.success) return { ok: false, error: NOTE_ERROR.invalid };
  const sb = await supabaseServer();

  const note = await loadNote(sb, id.data);
  if (!note) return { ok: false, error: NOTE_ERROR.missing };
  const { data } = await sb.from("note_versions").select("content").eq("id", ver.data).eq("note_id", note.id).maybeSingle();
  if (!data) return { ok: false, error: NOTE_ERROR.missing };
  return { ok: true, content: sanitiseContent(templateKeys(note.note_templates?.schema), data.content) };
}
