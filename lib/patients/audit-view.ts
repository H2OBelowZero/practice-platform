/** Plain-language names for the audit actions staff will see on a patient's Audit tab. Unknown actions show their code. */
const ACTION_TEXT: Record<string, string> = {
  "patient.view": "Opened the record",
  "patient.create": "Added the patient",
  "patient.update": "Changed details",
  "patient.archive": "Archived the patient",
  "patient.restore": "Restored the patient",
  "patient.invite": "Invited to the portal",
  "form.request": "Requested a form",
  "form.view": "Opened a submitted form",
  "form.submit": "Form submitted",
  "form.return": "Returned a form for correction",
  "consent.grant": "Consent given",
  "consent.withdraw": "Consent withdrawn",
};
export const auditActionText = (action: string): string => (Object.hasOwn(ACTION_TEXT, action) ? ACTION_TEXT[action] : action);

/** A short line from an audit row's detail: lists become "fields: a, b", plain values "key: value"; nested objects are left out. */
export function auditDetailText(detail: unknown): string {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (Array.isArray(v)) parts.push(`${k}: ${v.filter((x) => typeof x !== "object").join(", ")}`);
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${v}`);
  }
  return parts.join("; ").slice(0, 300);
}
