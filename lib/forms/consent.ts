import { CONSENT_PURPOSES, type ConsentPurpose, type FormField, type FormSchema } from "./validate";

/** The checkbox fields of a template that record a consent when the form is submitted. */
export const consentFields = (schema: FormSchema): FormField[] => schema.fields.filter((f) => f.type === "checkbox" && !!f.consentPurpose);

/**
 * The consent purposes to record for these (already validated) answers: one per consent checkbox that is ticked.
 * The database checks the same thing again (submit_form: declared in the template, none twice, required ones present, listed exactly when ticked).
 */
export function consentPurposesFrom(schema: FormSchema, answers: Record<string, unknown>): string[] {
  return consentFields(schema).filter((f) => Object.hasOwn(answers, f.key) && answers[f.key] === true).map((f) => f.consentPurpose as string);
}

/** Plain-language wording for each purpose: what it covers, and what withdrawing it means. */
export const PURPOSE_INFO: Record<ConsentPurpose, { label: string; covers: string; consequence: string }> = {
  treatment: {
    label: "Treatment",
    covers: "Your agreement to take part in psychological assessment and therapy with this practice.",
    consequence: "Withdrawing consent to treatment may affect your care: your psychologist may not be able to continue seeing you until you have talked it through.",
  },
  privacy_notice: {
    label: "Privacy notice",
    covers: "Your agreement that the practice may keep and use your personal and health information as described in its privacy notice.",
    consequence: "The practice may not be able to keep your records or give you a service without this, so withdrawing it may affect your care.",
  },
  telehealth: {
    label: "Online and phone sessions",
    covers: "Your agreement to have sessions by video or telephone.",
    consequence: "You will not be able to book online or phone sessions. You can still have sessions in person.",
  },
  financial_terms: {
    label: "Fees and payment terms",
    covers: "Your agreement to the practice's fees, payment terms and cancellation rules.",
    consequence: "The practice will contact you about how your account will be handled. Fees for sessions you have already had still apply.",
  },
  share_referrer: {
    label: "Sharing with your referrer",
    covers: "Your permission for the practice to share the information you chose with the doctor or professional who referred you.",
    consequence: "Nothing more will be shared with them. Information already shared cannot be taken back.",
  },
  share_insurer: {
    label: "Sharing with your medical aid",
    covers: "Your permission for the practice to share the information needed for claims with your medical aid.",
    consequence: "The practice will no longer submit claims for you, so you may need to pay your account yourself. Claims already sent are not affected.",
  },
};

/** Every purpose in a fixed order (the order used on the privacy page and the staff matrix). */
export const PURPOSE_ORDER: readonly ConsentPurpose[] = CONSENT_PURPOSES;

export const isPurpose = (s: unknown): s is ConsentPurpose => typeof s === "string" && (CONSENT_PURPOSES as readonly string[]).includes(s);

/** Text of the withdrawal confirmation panel: what happens, who is told, and purpose-specific consequences. */
export function withdrawalCopy(purpose: ConsentPurpose): { title: string; lines: string[] } {
  const info = PURPOSE_INFO[purpose];
  return {
    title: `Withdraw your consent: ${info.label}?`,
    lines: [
      "The practice will be notified straight away that you have withdrawn this consent, and your psychologist may contact you.",
      info.consequence,
      "Your earlier agreement stays on record, with the date you withdrew it. You can agree again later by completing the form again.",
    ],
  };
}

export type ConsentRow = { purpose: string; granted: boolean; granted_at: string | null; withdrawn_at: string | null; template_version: number | null; form_submission_id: string | null };
export type ConsentView =
  | { state: "granted"; at: string | null; version: number | null; submissionId: string | null }
  | { state: "withdrawn"; at: string | null; version: number | null; submissionId: string | null; grantedAt: string | null }
  | { state: "none" };

/** What to show for a purpose given its consent row (or no row). */
export function consentView(row: ConsentRow | undefined): ConsentView {
  if (!row) return { state: "none" };
  if (row.granted) return { state: "granted", at: row.granted_at, version: row.template_version, submissionId: row.form_submission_id };
  if (row.withdrawn_at) return { state: "withdrawn", at: row.withdrawn_at, version: row.template_version, submissionId: row.form_submission_id, grantedAt: row.granted_at };
  return { state: "none" };
}
