import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "@/lib/auth/roles";

export type PendingNote = {
  id: string; patient_id: string; starts_at: string;
  patients: { first_name: string; last_name: string } | null;
  session_types: { name: string } | null;
  clinical_notes: { state: string }[] | null;
};

/** An attended appointment is "to complete" until it has a signed (or amended) note; a draft, or no note at all, still counts. */
export const pendingAppointments = <T extends { clinical_notes: { state: string }[] | null }>(rows: T[]): T[] =>
  rows.filter((r) => !(r.clinical_notes ?? []).some((n) => n.state === "signed" || n.state === "amended"));

const CAP = 500; // ponytail: the newest 500 attended sessions; a practice with a bigger backlog needs a count query instead

/**
 * Dashboard helper (Task 16): attended appointments with no signed note, newest first, and how many. Read through the caller's own (RLS)
 * client, and only for the psychologist: any other role gets null (the dashboard hides the card), so nothing about notes is queried.
 * Counts and names only; no note content is read.
 */
export async function notesToComplete(sb: SupabaseClient, role: Role): Promise<{ count: number; items: PendingNote[] } | null> {
  if (role !== "psychologist") return null;
  const { data, error } = await sb.from("appointments")
    .select("id, patient_id, starts_at, patients(first_name, last_name), session_types(name), clinical_notes(state)")
    .eq("status", "attended").order("starts_at", { ascending: false }).limit(CAP);
  if (error) return null;
  const items = pendingAppointments((data ?? []) as unknown as PendingNote[]);
  return { count: items.length, items };
}
