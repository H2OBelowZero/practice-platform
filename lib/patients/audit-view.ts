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
  "note.create": "Started a clinical note",
  "note.view": "Opened a clinical note",
  "note.sign": "Signed a clinical note",
  "note.addendum": "Added an addendum to a clinical note",
  "consent.grant": "Consent given",
  "consent.withdraw": "Consent withdrawn",
  "export.report": "Downloaded a report as CSV",
};
export const auditActionText = (action: string): string => (Object.hasOwn(ACTION_TEXT, action) ? ACTION_TEXT[action] : action);

/**
 * The PostgREST `or` filter for a patient's Audit tab: rows whose entity id is the patient or one of their form submissions, plus note events
 * (entity clinical_notes) whose detail names this patient. Note audit detail holds ids only (patient_id), never text. Ids are uuids from the database.
 */
export const patientAuditFilter = (patientId: string, entityIds: string[]): string =>
  `entity_id.in.(${entityIds.join(",")}),and(entity.eq.clinical_notes,detail->>patient_id.eq.${patientId})`;

/** A short line from an audit row's detail: lists become "fields: a, b", plain values "key: value"; nested objects are left out. */
export function auditDetailText(detail: unknown): string {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (k === "patient_id") continue; // the tab is already this patient's
    if (Array.isArray(v)) parts.push(`${k}: ${v.filter((x) => typeof x !== "object").join(", ")}`);
    else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${v}`);
  }
  return parts.join("; ").slice(0, 300);
}
