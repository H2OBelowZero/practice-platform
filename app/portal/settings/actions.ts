"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { safely } from "@/lib/appointments/followups";
import type { ActionState } from "@/lib/appointments/types";
import { requireRole } from "@/lib/auth/session";
import { PREFS_ERROR, changedFields, mergePrefs, parsePrefsInput, readPrefs } from "@/lib/portal/prefs";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Save the signed-in patient's reminder choices on their OWN record. The update goes through the user's client: RLS lets a patient update only the
 * row whose user_id is theirs, and the guard trigger (patients_guard) protects every column but contact details and comms_prefs. A guardian has no
 * record of their own here, so nothing is found to update. Audit: field names only.
 */
export async function updatePrefs(raw: unknown): Promise<ActionState> {
  const me = await requireRole(["patient", "guardian"]);
  const next = parsePrefsInput(raw);
  if (!next) return { error: PREFS_ERROR.invalid };
  const sb = await supabaseServer();

  const { data: mine, error } = await sb.from("patients").select("id, comms_prefs").eq("user_id", me.userId).order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) return { error: PREFS_ERROR.save };
  if (!mine) return { error: PREFS_ERROR.noRecord };

  const saved = await sb.from("patients").update({ comms_prefs: mergePrefs(mine.comms_prefs, next) }).eq("id", mine.id).eq("user_id", me.userId).select("id");
  if (saved.error || !saved.data?.length) return { error: PREFS_ERROR.save };

  const fields = changedFields(readPrefs(mine.comms_prefs), next);
  if (fields.length > 0) await safely("prefs.update", () => audit("prefs.update", "patients", mine.id as string, { fields }));
  return redirect("/portal/settings?notice=saved");
}
