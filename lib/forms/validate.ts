import { isRealDate } from "@/lib/time";

/** The purposes the `consents` table accepts (check constraint in 0004_forms_tasks.sql; tests/unit/forms.test.ts keeps the two in step). */
export const CONSENT_PURPOSES = ["treatment", "privacy_notice", "telehealth", "financial_terms", "share_referrer", "share_insurer"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export type FieldType = "text" | "textarea" | "date" | "select" | "checkbox";
export const FIELD_TYPES: readonly FieldType[] = ["text", "textarea", "date", "select", "checkbox"];

/** `help` is optional small print under the label; `consentPurpose` (checkbox only) records a consent per purpose when the form is submitted. */
export type FormField = { key: string; label: string; type: FieldType; required?: boolean; options?: string[]; consentPurpose?: string; help?: string };
/**
 * `title` and `intro` (paragraphs separated by a blank line) are shown above the fields.
 * `restricted: true` marks clinical history: the admin cannot read submissions of such a template (enforced by RLS, migration 0012).
 */
export type FormSchema = { title?: string; intro?: string; restricted?: boolean; fields: FormField[] };

export const MAX_LEN = { text: 2000, textarea: 10000 } as const;

export type ValidationResult = {
  ok: boolean;
  /** One plain-language message per field key. */
  errors: Record<string, string>;
  /** Only the answers the schema asks for, in the right shape: store this, never the raw input. */
  clean: Record<string, string | boolean>;
};

/**
 * Check submitted answers against a template schema, on the server, whatever the browser did.
 * Keys that are not in the schema are ignored (and left out of `clean`); inherited keys such as "constructor" never count as answers.
 * A required checkbox must be true; a consent checkbox must be a real boolean (the string "true" is not accepted).
 */
export function validateAnswers(schema: FormSchema, answers: Record<string, unknown>): ValidationResult {
  const errors: Record<string, string> = {};
  const clean: Record<string, string | boolean> = {};
  const given = answers && typeof answers === "object" ? answers : {};

  for (const f of schema.fields) {
    const v: unknown = Object.hasOwn(given, f.key) ? given[f.key] : undefined;
    const blank = v === undefined || v === null || (typeof v === "string" && v.trim() === "");

    if (f.type === "checkbox") {
      if (v !== undefined && v !== null && typeof v !== "boolean") { errors[f.key] = `${f.label}: choose yes or no.`; continue; }
      if (f.required && v !== true) { errors[f.key] = f.consentPurpose ? `${f.label}: please tick the box to continue.` : `${f.label} is required`; continue; }
      if (typeof v === "boolean") clean[f.key] = v;
      continue;
    }

    if (blank) {
      if (f.required) errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (typeof v !== "string") { errors[f.key] = `${f.label} is not valid`; continue; }

    if (f.type === "select") {
      if (!f.options?.includes(v)) { errors[f.key] = `${f.label} has an invalid choice`; continue; }
    } else if (f.type === "date") {
      if (!isRealDate(v)) { errors[f.key] = `${f.label} must be a real date (YYYY-MM-DD)`; continue; }
    } else {
      const max = MAX_LEN[f.type];
      if (v.length > max) { errors[f.key] = `${f.label} must be at most ${max} characters`; continue; }
    }
    clean[f.key] = f.type === "text" || f.type === "textarea" ? v.trim() : v;
  }
  return { ok: Object.keys(errors).length === 0, errors, clean };
}

/**
 * Structural check of a template schema (for seeds and for 11b before it renders one). Returns a list of problems; empty means fine.
 * Anything stored in form_templates.schema should pass this.
 */
export function checkSchema(schema: unknown): string[] {
  const problems: string[] = [];
  const s = schema as { fields?: unknown } | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.fields) || s.fields.length === 0) return ["schema needs a non-empty fields array"];
  const restricted = (s as { restricted?: unknown }).restricted;
  if (restricted !== undefined && typeof restricted !== "boolean") problems.push("restricted must be true or false");
  const seen = new Set<string>();
  for (const [i, raw] of s.fields.entries()) {
    const f = raw as Partial<FormField> | null;
    const at = `fields[${i}]${f && typeof f.key === "string" ? ` (${f.key})` : ""}`;
    if (!f || typeof f !== "object") { problems.push(`${at} is not an object`); continue; }
    if (typeof f.key !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(f.key)) problems.push(`${at}: key must be lower_snake_case`);
    else if (seen.has(f.key)) problems.push(`${at}: duplicate key`);
    else seen.add(f.key);
    if (typeof f.label !== "string" || f.label.trim() === "") problems.push(`${at}: label is empty`);
    if (!f.type || !FIELD_TYPES.includes(f.type)) { problems.push(`${at}: unknown type`); continue; }
    if (f.type === "select" && (!Array.isArray(f.options) || f.options.length < 2 || f.options.some((o) => typeof o !== "string" || o === "") || new Set(f.options).size !== f.options.length)) problems.push(`${at}: select needs two or more distinct non-empty options`);
    if (f.type !== "select" && f.options !== undefined) problems.push(`${at}: only select fields have options`);
    if (f.consentPurpose !== undefined) {
      if (f.type !== "checkbox") problems.push(`${at}: consentPurpose is only for checkbox fields`);
      if (!(CONSENT_PURPOSES as readonly string[]).includes(f.consentPurpose)) problems.push(`${at}: consentPurpose "${f.consentPurpose}" is not an allowed purpose`);
    }
  }
  const purposes = (s.fields as Partial<FormField>[]).map((f) => f?.consentPurpose).filter(Boolean);
  if (new Set(purposes).size !== purposes.length) problems.push("a consent purpose is used by more than one field");
  return problems;
}
