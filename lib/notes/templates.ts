/** Labels, help and placeholders for the field names the seeded note_templates use (SOAP, DAP, Free form). Unknown field names still render, with a plain label. */
export type NoteField = { key: string; label: string; help: string; placeholder: string };

const KNOWN: Record<string, Omit<NoteField, "key">> = {
  subjective: { label: "Subjective", help: "What the patient reports: mood, concerns, events since the last session, in their own words where useful.", placeholder: "Patient reports…" },
  objective: { label: "Objective", help: "What you observed: presentation, affect, behaviour, and any measures used in the session.", placeholder: "Observed…" },
  assessment: { label: "Assessment", help: "Your clinical impression and formulation, and progress against the treatment goals.", placeholder: "Clinical impression…" },
  plan: { label: "Plan", help: "Interventions, homework, referrals, the next session and any follow-up.", placeholder: "Next steps…" },
  data: { label: "Data", help: "A factual account of the session: what was said and done, and what you observed.", placeholder: "Session content and observations…" },
  notes: { label: "Session notes", help: "Free-form notes for this session.", placeholder: "Write your session notes here…" },
};

const humanise = (k: string) => { const t = k.replace(/[_-]+/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) : "Notes"; };
const SAFE_KEY = /^[a-z][a-z0-9_]{0,39}$/i;

/** The field names of a template's `schema.fields` (strings only, de-duplicated, at most 20); anything else in the schema is ignored. */
export function templateKeys(schema: unknown): string[] {
  const fields = schema && typeof schema === "object" ? (schema as { fields?: unknown }).fields : undefined;
  if (!Array.isArray(fields)) return [];
  return [...new Set(fields.filter((f): f is string => typeof f === "string" && SAFE_KEY.test(f)))].slice(0, 20);
}

/** The fields to show for a template, in schema order. */
export const templateFields = (schema: unknown): NoteField[] =>
  templateKeys(schema).map((key) => ({ key, ...(Object.hasOwn(KNOWN, key) ? KNOWN[key] : { label: humanise(key), help: "", placeholder: "" }) }));
