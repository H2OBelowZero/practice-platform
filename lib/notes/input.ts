import { z } from "zod";
import { NOTE_FIELD_MAX } from "./content";
import { RISK_LEVELS } from "./risk";

// Zod input schemas for the note actions. Content is checked for shape and size here, then cut down to the template's fields by sanitiseContent.
export const noteId = z.uuid();
export const patientIdSchema = z.uuid();
const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const contentSchema = z.record(z.string().max(100), z.string().max(NOTE_FIELD_MAX));
export const riskSchema = z.object({ level: z.enum(RISK_LEVELS), notes: z.string().max(NOTE_FIELD_MAX) });
export const createSchema = z.object({ template: z.uuid(), appointment: z.preprocess(blankToUndef, z.uuid().optional()) });
export const addendumSchema = z.object({ content: z.string({ error: "Write the addendum." }).trim().min(1, "Write the addendum.").max(NOTE_FIELD_MAX, "Keep the addendum under 20 000 characters.") });
export const versionId = z.number().int().positive();
