import { RISK_LEVELS, type RiskLevel } from "./risk";

/** Longest text kept for any one note field, risk note or addendum (also the textarea maxLength and the Zod limit). */
export const NOTE_FIELD_MAX = 20000;
/** Autosave pause for the note editor (the forms editor uses 1.5 s; a clinical note is longer and slower). */
export const NOTE_AUTOSAVE_MS = 3000;

export type NoteContent = Record<string, string>;
export type NoteRisk = { level: RiskLevel; notes: string };

/**
 * Keep exactly the template's fields: unknown keys and non-string values are dropped, missing fields become "", and each value is cut at
 * NOTE_FIELD_MAX (a defence only; the action's Zod schema refuses longer text so nothing is silently shortened).
 */
export function sanitiseContent(keys: readonly string[], raw: unknown): NoteContent {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: NoteContent = {};
  for (const k of keys) { const v = Object.hasOwn(src, k) ? src[k] : undefined; out[k] = typeof v === "string" ? v.slice(0, NOTE_FIELD_MAX) : ""; }
  return out;
}

/** A well-formed risk object from whatever the database or browser holds: an unknown level becomes "none". */
export function sanitiseRisk(raw: unknown): NoteRisk {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const level = (RISK_LEVELS as readonly unknown[]).includes(src.level) ? (src.level as RiskLevel) : "none";
  return { level, notes: typeof src.notes === "string" ? src.notes.slice(0, NOTE_FIELD_MAX) : "" };
}

/** True when every field is blank (whitespace only): such a note is not signed. Risk alone does not make a note. */
export const isEmptyNote = (content: NoteContent): boolean => Object.values(content).every((v) => v.trim() === "");

/** Words across all fields. */
export const wordCount = (content: NoteContent): number =>
  Object.values(content).reduce((n, v) => n + (v.trim() ? v.trim().split(/\s+/).length : 0), 0);
