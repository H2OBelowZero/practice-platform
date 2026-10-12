"use server";

import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import type { ActionState } from "@/lib/appointments/types";
import { FORM_ERROR, formErrorText } from "@/lib/forms/errors";
import { withdrawSchema } from "@/lib/forms/input";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Withdraw one consent (patient, or a guardian holding permissions.forms for that person). Goes through set_consent(..., false, null) on the
 * caller's own client: the database checks who may act, keeps the record of what was agreed with the withdrawal date, opens the high-priority
 * "Consent withdrawn" task for the practice and writes the audit row.
 */
export async function withdrawConsent(rawPatient: unknown, rawPurpose: unknown): Promise<ActionState> {
  await requireRole(["patient", "guardian"]);
  const v = withdrawSchema.safeParse({ patientId: rawPatient, purpose: rawPurpose });
  if (!v.success) return { error: FORM_ERROR.invalid };
  const sb = await supabaseServer();

  // nothing to withdraw unless it is currently given (set_consent would otherwise record a withdrawal that never had a grant)
  const { data: row } = await sb.from("consents").select("granted").eq("patient_id", v.data.patientId).eq("purpose", v.data.purpose).maybeSingle();
  if (!row) return { error: "We could not find that consent." };
  if (row.granted !== true) return { error: "This consent has already been withdrawn." };

  const { error } = await sb.rpc("set_consent", { p_patient: v.data.patientId, p_purpose: v.data.purpose, p_granted: false, p_submission: null });
  if (error) return { error: formErrorText(error.message) };
  return redirect("/portal/privacy?notice=withdrawn");
}
