import { PURPOSE_INFO } from "@/lib/forms/consent";
import type { ConsentPurpose } from "@/lib/forms/validate";
import { statusMeta } from "@/lib/status";

/** Plain wording for the compliance counts (keys from report_compliance, 0025). */
export const ACTIVITY_LABEL: Record<string, string> = {
  logins: "Sign-ins", patient_views: "Patient records opened", note_views: "Clinical notes opened", claim_views: "Claims opened", exports: "Data exports (CSV downloads)",
  settings_changes: "Settings changes", consent_grants: "Consents given", consent_withdrawals: "Consents withdrawn", note_addenda: "Addenda added to signed notes",
};

export const consentLabel = (purpose: string): string => PURPOSE_INFO[purpose as ConsentPurpose]?.label ?? purpose;
export const claimStatusLabel = (status: string): string => statusMeta(status).label;
