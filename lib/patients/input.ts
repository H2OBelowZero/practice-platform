import { z } from "zod";
import { isRealDate, sastDate } from "@/lib/time";
import { LANGUAGES, PAYERS } from "./options";
import { normaliseZaPhone } from "./phone";

/** Empty strings from a form become undefined. */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optText = (max: number) => z.preprocess(blank, z.string().trim().max(max, `Keep this under ${max} characters.`).optional());
const tick = z.preprocess((v) => v === "on" || v === "true", z.boolean());
const name = (what: string) => z.string({ error: `Enter a ${what}.` }).trim().min(1, `Enter a ${what}.`).max(100, `Keep the ${what} under 100 characters.`);
const phone = z.preprocess(blank, z.string().transform((s, ctx) => {
  const p = normaliseZaPhone(s);
  if (!p) { ctx.addIssue({ code: "custom", message: "Enter a valid phone number, for example 082 123 4567." }); return z.NEVER; }
  return p;
}).optional());

const profileShape = {
  first_name: name("first name"),
  last_name: name("last name"),
  date_of_birth: z.preprocess(blank, z.string()
    .refine(isRealDate, "Enter a real date of birth.")
    .refine((d) => d >= "1900-01-01", "Enter a real date of birth.")
    .refine((d) => d <= sastDate(new Date()), "The date of birth cannot be in the future.").optional()),
  email: z.preprocess(blank, z.string().trim().max(254, "Keep the email address under 254 characters.").pipe(z.email("Enter a valid email address.")).transform((s) => s.toLowerCase()).optional()),
  phone,
  language: z.enum(LANGUAGES.map((l) => l[0]) as [string, ...string[]], { error: "Choose a language." }),
  comms_email: tick,
  comms_sms: tick,
};

const adminShape = {
  emergency_name: optText(100),
  emergency_phone: phone,
  emergency_relationship: optText(60),
  referral_source: optText(200),
  payer: z.enum(PAYERS.map((p) => p[0]) as [string, ...string[]], { error: "Choose who pays." }),
};

/** An emergency contact needs at least a name and a phone number once any part of it is filled in. */
const emergencyRule = (v: { emergency_name?: string; emergency_phone?: string; emergency_relationship?: string }, ctx: z.RefinementCtx) => {
  if (!(v.emergency_name || v.emergency_phone || v.emergency_relationship)) return;
  if (!v.emergency_name) ctx.addIssue({ code: "custom", path: ["emergency_name"], message: "Enter the emergency contact's name." });
  if (!v.emergency_phone) ctx.addIssue({ code: "custom", path: ["emergency_phone"], message: "Enter the emergency contact's phone number." });
};

export const profileSchema = z.object(profileShape);
export const adminSchema = z.object({ ...adminShape, status: z.enum(["prospect", "active"], { error: "Choose prospect or active." }).optional() }).superRefine(emergencyRule);
export const createSchema = z.object({ ...profileShape, ...adminShape, status: z.enum(["prospect", "active"], { error: "Choose prospect or active." }), confirmDuplicate: tick }).superRefine(emergencyRule);
export const restoreSchema = z.object({ status: z.enum(["prospect", "active"], { error: "Choose prospect or active." }) });

export const patientId = z.uuid();

export type EmergencyContact = { name: string; phone: string; relationship?: string };
export const emergencyContact = (v: { emergency_name?: string; emergency_phone?: string; emergency_relationship?: string }): EmergencyContact | null =>
  v.emergency_name && v.emergency_phone ? { name: v.emergency_name, phone: v.emergency_phone, ...(v.emergency_relationship ? { relationship: v.emergency_relationship } : {}) } : null;

/** First message per field, for showing next to each input. */
export function fieldErrors(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of error.issues) { const k = String(i.path[0] ?? "form"); if (!(k in out)) out[k] = i.message; }
  return out;
}
