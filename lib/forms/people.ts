import type { SupabaseClient } from "@supabase/supabase-js";
import { guardianMayUseForms } from "./access";

export type Person = { id: string; first_name: string; own: boolean };

/**
 * The people the signed-in portal user can handle forms and consents for: themself, and each person they are a current guardian of with
 * permissions.forms. Both queries run through the caller's client (RLS); the database re-checks on every write.
 */
export async function formPeople(sb: SupabaseClient, userId: string, today: string): Promise<Person[]> {
  const [patients, guardianships] = await Promise.all([
    sb.from("patients").select("id, first_name, user_id"),
    sb.from("guardianships").select("patient_id, permissions, valid_from, valid_to").eq("guardian_user_id", userId),
  ]);
  const allowed = new Set((guardianships.data ?? []).filter((g) => guardianMayUseForms(g, today)).map((g) => g.patient_id as string));
  return (patients.data ?? [])
    .filter((p) => p.user_id === userId || allowed.has(p.id as string))
    .map((p) => ({ id: p.id as string, first_name: p.first_name as string, own: p.user_id === userId }))
    .sort((a, b) => Number(b.own) - Number(a.own) || a.first_name.localeCompare(b.first_name));
}
