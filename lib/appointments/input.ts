import { z } from "zod";
import { isRealDate, sastInstant } from "@/lib/time";

export { canonicalIso as isoInstant } from "@/lib/booking/input";

export const apptId = z.uuid();

/** Empty strings from a form become undefined. */
const blankToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time.");
const realDate = z.string().refine(isRealDate, "Choose a date.");

export const declineSchema = z.object({ reason: z.string().trim().min(1, "Please give a reason.").max(500) });
export const staffCancelSchema = z.object({
  reason: z.preprocess(blankToUndef, z.string().trim().max(500).optional()),
  chargeFee: z.preprocess((v) => v === "on" || v === "true", z.boolean()),
});
/** Override hours: any SAST date and time, turned into an instant. */
export const overrideTimeSchema = z.object({ date: realDate, time: hhmm }).transform((v, ctx) => {
  const iso = sastInstant(v.date, v.time);
  if (!iso) { ctx.addIssue({ code: "custom", message: "Choose a date and time." }); return z.NEVER; }
  return iso;
});
export const createSchema = z.object({
  patientId: z.uuid(), typeId: z.uuid(), date: realDate, time: hhmm, status: z.enum(["confirmed", "tentative"]),
});
