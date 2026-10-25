/** Plain-language messages for the errors the forms database functions and policies raise. */
export const FORM_ERROR = {
  generic: "We could not save that. Please try again.",
  missing: "We could not find that form.",
  invalid: "That request was not valid. Please refresh the page and try again.",
  closed: "This form has already been submitted, so it can no longer be changed.",
  forbidden: "You do not have permission to do that.",
  unavailable: "This form is not available right now. Please contact the practice.",
  fix: "Please check the answers listed below and try again.",
  conflict: "This form was changed elsewhere. Reload to see the latest answers.",
} as const;

/** Map a database error message (from submit_form, set_consent, fs_guard, RLS) to text for the person. */
export function formErrorText(message: string | undefined | null): string {
  const m = message ?? "";
  if (/submission_not_open|immutable|invalid_status_transition/.test(m)) return FORM_ERROR.closed;
  if (/forbidden|row-level security|permission denied/.test(m)) return FORM_ERROR.forbidden;
  if (/consent_required_missing|consent_answer_mismatch|consent_not_in_template|duplicate_consent_purpose/.test(m)) return "Please check the consent boxes on this form and try again.";
  if (/required_field_missing|invalid_field_value/.test(m)) return "Please answer every required question with one of the choices offered, then try again.";
  if (/answers_too_large/.test(m)) return "Your answers are too long to save. Please shorten them and try again.";
  if (/template_not_active/.test(m)) return "This form is no longer available. Please contact the practice.";
  return FORM_ERROR.generic;
}

