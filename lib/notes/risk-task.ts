import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NoteRisk } from "./content";
import { riskSource, riskTask } from "./risk";

/**
 * Raise the staff task for a moderate or high risk flag, through the psychologist's own client (tasks RLS: staff). At most one task per note and level:
 * the source `risk_flag:<noteId>:<level>` is looked up first (any status: a task already actioned is not raised again by the next autosave).
 * The title is fixed text and the task holds no note content. Returns false only when the lookup or insert failed.
 * ponytail: lookup then insert is not atomic, so two tabs saving in the same instant could add two; a partial unique index on tasks.source would close it.
 */
export async function ensureRiskTask(sb: SupabaseClient, note: { id: string; patient_id: string; appointment_id: string | null }, risk: NoteRisk): Promise<boolean> {
  const task = riskTask(risk);
  if (!task || (risk.level !== "moderate" && risk.level !== "high")) return true;
  const source = riskSource(note.id, risk.level);
  const found = await sb.from("tasks").select("id").eq("source", source).limit(1);
  if (found.error) return false;
  if (found.data.length) return true;
  const { error } = await sb.from("tasks").insert({ title: task.title, priority: task.priority, patient_id: note.patient_id, appointment_id: note.appointment_id, source });
  return !error;
}
