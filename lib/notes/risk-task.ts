import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NoteRisk } from "./content";
import { riskTask } from "./risk";

/**
 * Raise the staff task for a moderate or high risk flag through raise_risk_task() (0013), with the psychologist's own client. The database does the
 * work atomically: one task per note (partial unique index, ON CONFLICT DO NOTHING), assigned to the caller, level kept in tasks.meta; a rise from
 * moderate to high updates and re-opens it; none, low and lower levels do nothing; a finished task is not re-raised at the same level. Risk tasks are
 * visible to the psychologist only (RLS). The title is fixed text and the task holds no note content. Returns false only when the call failed.
 */
export async function ensureRiskTask(sb: SupabaseClient, noteId: string, risk: NoteRisk): Promise<boolean> {
  const task = riskTask(risk);
  if (!task) return true;
  const { error } = await sb.rpc("raise_risk_task", { p_note: noteId, p_level: risk.level, p_title: task.title });
  return !error;
}
