import { validateAnswers, type FormSchema } from "./validate";

/**
 * Sanitise answers for an autosave: only the template's own keys, in the right type, text trimmed, anything invalid left out,
 * and NOTHING required (a half-finished form must be savable). The full check (validateAnswers) runs on submit.
 */
export function draftAnswers(schema: FormSchema, answers: Record<string, unknown>): Record<string, string | boolean> {
  const relaxed: FormSchema = { ...schema, fields: schema.fields.map((f) => ({ ...f, required: false })) };
  return validateAnswers(relaxed, answers).clean;
}
