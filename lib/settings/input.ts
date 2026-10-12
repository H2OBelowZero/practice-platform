import { z } from "zod";
import { formatZarInput, parseZarToCents } from "@/lib/money";

// Settings input (Zod). The same limits are CHECK constraints in 0027, so a value that passes here is accepted by the database and one that does not never gets there.
// Field names are the form control ids, so a server error can be shown next to the right control.
export const LIMITS = {
  name: 120, registrationNo: 40, hpcsaNo: 40, crisisText: 1000, paymentInstructions: 1500,
  cancellationWindowHours: 336, lateFeeCents: 1_000_000, vatRate: 100,
  durationMin: { min: 5, max: 240 }, feeCents: 1_000_000, bufferMin: 120, reason: 200, retainYears: 100,
} as const;

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
/** A checkbox / switch: "on" when ticked, absent when not. */
export const checked = z.preprocess((v) => v === "on" || v === "true", z.boolean());

const wholeNumber = (what: string, min: number, max: number, unit = "") =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: `Enter ${what}.` })
    .regex(/^\d{1,6}$/, `Enter ${what} as a whole number.`)
    .transform(Number)
    .refine((n) => n >= min && n <= max, `${what[0].toUpperCase()}${what.slice(1)} must be between ${min} and ${max}${unit}.`));

const optionalText = (what: string, max: number) =>
  z.preprocess(blank, z.string().trim().max(max, `Keep ${what} under ${max} characters.`).optional());

/** A rand amount typed by a person, as cents between 0 and `maxCents`. */
const rand = (what: string, maxCents: number) =>
  z.preprocess((v) => (typeof v === "string" ? v : ""), z.string().transform((s, ctx) => {
    const c = parseZarToCents(s);
    if (c === null || c > maxCents) { ctx.addIssue({ code: "custom", message: `Enter ${what} in rand, for example 950,00.` }); return z.NEVER; }
    return c;
  }));

const vatRate = z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string({ error: "Enter the VAT rate." })
  .regex(/^\d{1,3}([.,]\d{1,2})?$/, "Enter the VAT rate as a percentage, for example 15.")
  .transform((s) => Number(s.replace(",", ".")))
  .refine((n) => n >= 0 && n <= LIMITS.vatRate, "The VAT rate must be between 0 and 100."));

export const practiceSchema = z.object({
  name: z.string({ error: "Enter the practice name." }).trim().min(1, "Enter the practice name.").max(LIMITS.name, `Keep the name under ${LIMITS.name} characters.`),
  registrationNo: optionalText("the registration number", LIMITS.registrationNo),
  hpcsaNo: optionalText("the HPCSA number", LIMITS.hpcsaNo),
  approvalMode: z.enum(["auto", "request"], { error: "Choose how new bookings are handled." }),
  cancellationWindowHours: wholeNumber("the cancellation window in hours", 0, LIMITS.cancellationWindowHours),
  lateCancelFee: rand("the late-cancellation fee", LIMITS.lateFeeCents),
  vatRegistered: checked,
  vatRate,
  crisisText: z.string({ error: "Enter the crisis and escalation text." }).trim().min(1, "Enter the crisis and escalation text.").max(LIMITS.crisisText, `Keep the crisis text under ${LIMITS.crisisText} characters.`),
});

export const paymentSchema = z.object({
  paymentInstructions: z.string({ error: "Enter the payment instructions." }).trim().min(1, "Enter the payment instructions.")
    .max(LIMITS.paymentInstructions, `Keep the payment instructions under ${LIMITS.paymentInstructions} characters.`),
  confirmed: z.preprocess((v) => v === "on", z.literal(true, { error: "Tick the box to confirm you have checked the bank details." })),
});

/** The same checks as paymentSchema, run in the browser BEFORE the review panel opens (the server runs paymentSchema again). Null = fine. */
export function paymentPrecheck(values: Record<string, string>): { error: string; field: string } | null {
  const r = paymentSchema.safeParse(values);
  if (r.success) return null;
  const issue = r.error.issues[0];
  return { error: issue?.message ?? "Please check the details.", field: String(issue?.path[0] ?? "") };
}

export const sessionTypeSchema = z.object({
  name: z.string({ error: "Enter a name for the session type." }).trim().min(1, "Enter a name for the session type.").max(LIMITS.name, `Keep the name under ${LIMITS.name} characters.`),
  durationMin: wholeNumber("the length in minutes", LIMITS.durationMin.min, LIMITS.durationMin.max),
  fee: rand("the fee", LIMITS.feeCents),
  format: z.enum(["in_person", "video"], { error: "Choose in person or video." }),
  bufferMin: wholeNumber("the buffer in minutes", 0, LIMITS.bufferMin),
  active: checked,
});

export const sessionTypeId = z.uuid();
export const blockId = z.uuid();

export const blockSchema = z.object({
  starts: z.string({ error: "Enter the date and time the block starts." }).trim().min(1, "Enter the date and time the block starts."),
  ends: z.string({ error: "Enter the date and time the block ends." }).trim().min(1, "Enter the date and time the block ends."),
  reason: optionalText("the reason", LIMITS.reason),
});

export const retentionSchema = z.object({
  recordType: z.string().trim().min(1).max(60),
  retainYears: z.preprocess(blank, z.preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string()
    .regex(/^\d{1,3}$/, "Enter the years as a whole number, or leave it empty to keep the records indefinitely.")
    .transform(Number)
    .refine((n) => n >= 1 && n <= LIMITS.retainYears, `Enter between 1 and ${LIMITS.retainYears} years, or leave it empty to keep the records indefinitely.`)).optional()),
  legalHold: checked,
});

export { formatZarInput };

// ---- database errors -----------------------------------------------------------------------------------------------------------------------------------
const CONSTRAINT_TEXT: [RegExp, string][] = [
  [/overlapping_hours/, "Two windows on that day overlap. Make one end before the other starts."],
  [/practices_name_len|session_types_name_len/, "Keep the name between 1 and 120 characters."],
  [/practices_registration_len|practices_hpcsa_len/, "Keep the registration and HPCSA numbers under 40 characters."],
  [/practices_crisis_len/, "The crisis text must be between 1 and 1000 characters."],
  [/practices_payment_len/, "Keep the payment instructions under 1500 characters."],
  [/practices_window_range/, "The cancellation window must be between 0 and 336 hours."],
  [/practices_late_fee_range/, "The late-cancellation fee can be at most R 10 000,00."],
  [/practices_vat_range/, "The VAT rate must be between 0 and 100."],
  [/session_types_duration_range/, "A session must last between 5 and 240 minutes."],
  [/session_types_fee_range/, "The fee can be at most R 10 000,00."],
  [/session_types_buffer_max|session_types_buffer_nonneg/, "The buffer must be between 0 and 120 minutes."],
  [/session_types_deposit_range/, "The fee cannot be lower than the deposit already set on this session type."],
  [/blocked_times_reason_len/, "Keep the reason under 200 characters."],
  [/check constraint "?blocked_times/, "The block must end after it starts."],
  [/retention_years_range/, "Enter between 1 and 100 years, or leave it empty."],
];

/** A friendly sentence for a Supabase/Postgres error from a settings write. Never echoes the raw message. */
export function settingsErrorText(e: { code?: string; message?: string } | null | undefined): string {
  const m = e?.message ?? "";
  for (const [re, text] of CONSTRAINT_TEXT) if (re.test(m)) return text;
  if (/forbidden|row-level security/i.test(m) || e?.code === "42501") return "Only the practitioner can change settings.";
  if (/invalid_time/.test(m)) return "Enter times like 08:00, in 5-minute steps.";
  if (/invalid_window\b/.test(m)) return "A window must end after it starts.";
  if (/invalid_windows/.test(m)) return "Use at most 8 windows in one day.";
  return "We could not save that. Please try again.";
}
