import { z } from "zod";
import { CONSENT_PURPOSES } from "./validate";

// Zod input schemas for the portal form actions. Anything from the browser goes through these first.
export const submissionId = z.uuid();
export const patientIdSchema = z.uuid();
export const templateIdSchema = z.uuid();
/** The answers object: shape only (keys and types are checked against the template by validateAnswers / draftAnswers). */
export const answersSchema = z.record(z.string().max(100), z.unknown());
export const startSchema = z.object({ patientId: patientIdSchema, templateId: templateIdSchema });
export const withdrawSchema = z.object({ patientId: patientIdSchema, purpose: z.enum(CONSENT_PURPOSES) });

/** Staff: the note shown to the patient when a form is returned. 1 to 1000 characters once trimmed (also a database check). */
export const returnNote = z.string({ error: "Write a short note for the patient." }).trim().min(1, "Write a short note for the patient.").max(1000, "Keep the note under 1000 characters.");
export const requestSchema = z.object({ template: templateIdSchema });
