import { z } from "zod";
import type { Values } from "@/lib/appointments/types";
import { type Result } from "@/lib/billing/input";
import { parseZarToCents } from "@/lib/money";
import { isRealDate } from "@/lib/time";
import { parseIcd10List } from "./icd10";

// Everything a staff member types into the medical aid and claim forms is parsed here, on the server, with Zod. Money is parsed from the typed
// text into integer cents (never floats). Messages are plain language; `field` is the id of the control the message is about.

export const uuid = z.uuid();

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optText = (what: string, max: number) => z.preprocess(blank, z.string().trim().max(max, `Keep the ${what} under ${max} characters.`).optional());
const optDate = (what: string) => z.preprocess(blank, z.string().trim().refine(isRealDate, `Enter a real ${what} date.`).refine((d) => d >= "1900-01-01" && d <= "2100-12-31", `Enter a real ${what} date.`).optional());

function fail(e: z.ZodError): { ok: false; error: string; field?: string } {
  const i = e.issues[0];
  return { ok: false, error: i?.message ?? "Please check the details and try again.", field: i?.path[0] === undefined ? undefined : String(i.path[0]) };
}
const run = <S extends z.ZodType>(schema: S, values: unknown): Result<z.output<S>> => {
  const p = schema.safeParse(values);
  return p.success ? { ok: true, value: p.data } : fail(p.error);
};

// ---- members --------------------------------------------------------------------------------------------------------------------
/** Member number: 3 to 30 letters, digits, hyphens or spaces. */
export const MEMBER_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 -]{1,28}[A-Za-z0-9]$/;
const memberSchema = z.object({
  memberId: z.preprocess(blank, uuid.optional()),
  scheme: z.string({ error: "Enter the medical aid scheme, for example Discovery." }).trim().min(1, "Enter the medical aid scheme, for example Discovery.").max(80, "Keep the scheme name under 80 characters."),
  plan: optText("plan name", 80),
  member_number: z.string({ error: "Enter the member number." }).trim()
    .min(3, "The member number must be at least 3 characters.").max(30, "The member number can be at most 30 characters.")
    .regex(MEMBER_NUMBER, "Use only letters, numbers, hyphens and spaces in the member number."),
  dependant_code: z.preprocess(blank, z.string().trim().regex(/^[A-Za-z0-9]{1,5}$/, "The dependant code is up to 5 letters or numbers, for example 00 or 01.").optional()),
  main_member_name: optText("main member's name", 100),
  valid_from: optDate("start"),
  valid_to: optDate("end"),
}).superRefine((v, ctx) => {
  if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) ctx.addIssue({ code: "custom", path: ["valid_to"], message: "The end date cannot be before the start date." });
});
export type MemberInput = z.output<typeof memberSchema>;
export const parseMemberForm = (values: Values): Result<MemberInput> => run(memberSchema, values);

// ---- claims ---------------------------------------------------------------------------------------------------------------------
export const TARIFF = /^[A-Za-z0-9]{1,20}$/;
export const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9 /-]{0,39}$/;
const amount = (what: string) => z.string({ error: `Enter ${what} in rand, for example 600 or 600,00.` }).transform((s, ctx) => {
  const c = parseZarToCents(s);
  if (c === null || c <= 0) { ctx.addIssue({ code: "custom", message: `Enter ${what} in rand, for example 600 or 600,00.` }); return z.NEVER; }
  return c;
});
const reference = (what: string) => z.preprocess(blank, z.string().trim().regex(REFERENCE, `Use only letters, numbers, spaces, hyphens and slashes in the ${what} (up to 40 characters).`).optional());

const claimFields = {
  memberId: z.uuid({ error: "Choose the medical aid member." }),
  amount: amount("the amount to claim"),
  tariff: z.string({ error: "Enter the tariff code." }).trim().regex(TARIFF, "The tariff code is 1 to 20 letters or numbers, for example 86205."),
  preauth: reference("pre-authorisation reference"),
};
const icd = z.string().optional().transform((s, ctx) => {
  const list = parseIcd10List(s);
  if (list === null) { ctx.addIssue({ code: "custom", path: ["icd10"], message: "Choose diagnosis codes from the list (at most 12)." }); return z.NEVER; }
  return list;
});
const claimSchema = z.object({ ...claimFields, icd10: icd });
export type ClaimFormInput = z.output<typeof claimSchema>;
/** The create / edit-draft form. `icd10` holds the chosen codes (empty when none, or when the person may not choose any). */
export const parseClaimForm = (values: Values): Result<ClaimFormInput> => run(claimSchema, values);

export const parseClaimRef = (values: Values): Result<{ claimRef: string | undefined }> =>
  run(z.object({ claim_ref: reference("claim reference") }).transform((v) => ({ claimRef: v.claim_ref })), values);

export const parseApproved = (values: Values): Result<{ approvedCents: number }> =>
  run(z.object({ approved: amount("the approved amount") }).transform((v) => ({ approvedCents: v.approved })), values);

export const REASON_MAX = 300;
export const parseRejection = (values: Values): Result<{ reason: string }> =>
  run(z.object({ reason: z.string({ error: "Give the reason the claim was rejected." }).trim().min(1, "Give the reason the claim was rejected.").max(REASON_MAX, `Keep the reason under ${REASON_MAX} characters.`) }), values);

export const REMITTANCE_REF_MAX = 100;
export const parseRemittance = (values: Values): Result<{ amountCents: number; ref: string }> =>
  run(z.object({
    amount: amount("the amount the scheme paid"),
    ref: z.string({ error: "Enter the remittance advice number." }).trim().min(1, "Enter the remittance advice number.").max(REMITTANCE_REF_MAX, `Keep the reference under ${REMITTANCE_REF_MAX} characters.`),
  }).transform((v) => ({ amountCents: v.amount, ref: v.ref })), values);
