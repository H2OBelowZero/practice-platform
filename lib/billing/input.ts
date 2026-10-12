import { z } from "zod";
import { computeInvoice } from "@/lib/billing/invoice";
import { formatZar, parseZarToCents } from "@/lib/money";
import { addDays, isRealDate } from "@/lib/time";
import type { Values } from "@/lib/appointments/types";

// Everything a staff member types into the billing forms is parsed here, on the server, with Zod. Money is parsed from the typed
// text into integer cents (never floats). The forms never submit totals: the server computes every figure (computeInvoice).

export const uuid = z.uuid();
export const PAYER_TYPES = ["self", "medical_aid", "split"] as const;
export type PayerType = (typeof PAYER_TYPES)[number];
export const MANUAL_METHODS = ["eft", "cash", "card_machine"] as const;
export type ManualMethod = (typeof MANUAL_METHODS)[number];

export const MAX_UNIT_CENTS = 100_000_000; // R 1 000 000 per unit
export const MAX_LINES = 20;
export const DEFAULT_DUE_DAYS = 14;
/** Default due date: 14 days after today (SAST). The practice has no due-days setting yet. */
export const defaultDueDate = (today: string): string => addDays(today, DEFAULT_DUE_DAYS);

const blank = (s: string | undefined) => (s ?? "").trim() === "";
const fieldMoney = (s: string | undefined): number | null => (s === undefined ? null : parseZarToCents(s));

export type InvoiceLineInput = { description: string; quantity: number; unitCents: number };
export type InvoiceFormInput = { lines: InvoiceLineInput[]; discountCents: number; dueDate: string; payer: PayerType; schemeCents: number | null };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const lineSchema = z.object({
  description: z.string().trim().min(1, "enter a description.").max(200, "keep the description under 200 characters."),
  quantity: z.string().trim().regex(/^\d{1,2}$/, "enter a quantity from 1 to 99.").transform(Number).refine((n) => n >= 1 && n <= 99, "enter a quantity from 1 to 99."),
  price: z.string().transform((s, ctx) => {
    const c = parseZarToCents(s);
    if (c === null || c > MAX_UNIT_CENTS) { ctx.addIssue({ code: "custom", message: "enter a price from R 0,00 to R 1 000 000,00, for example 950 or 950,00." }); return z.NEVER; }
    return c;
  }),
});

/** The line rows of a form (fields line_desc_N / line_qty_N / line_price_N), in index order, rows with nothing typed left out. */
export function lineRows(values: Values): { description: string; quantity: string; price: string }[] {
  const idx = new Set<number>();
  for (const k of Object.keys(values)) { const m = /^line_(?:desc|qty|price)_(\d{1,3})$/.exec(k); if (m) idx.add(Number(m[1])); }
  return [...idx].sort((a, b) => a - b)
    .map((i) => ({ description: values[`line_desc_${i}`] ?? "", quantity: values[`line_qty_${i}`] ?? "", price: values[`line_price_${i}`] ?? "" }))
    // a row that still only holds its default quantity is an empty row
    .filter((r) => !(blank(r.description) && blank(r.price) && (blank(r.quantity) || r.quantity.trim() === "1")));
}

/** Parse the create / edit-draft form. `today` is the SAST date (a due date in the past is refused). */
export function parseInvoiceForm(values: Values, today: string): Result<InvoiceFormInput> {
  const rows = lineRows(values);
  if (rows.length === 0) return fail("Add at least one line to the invoice.");
  if (rows.length > MAX_LINES) return fail(`An invoice can have at most ${MAX_LINES} lines.`);
  const lines: InvoiceLineInput[] = [];
  for (const [i, r] of rows.entries()) {
    const p = lineSchema.safeParse(r);
    if (!p.success) return fail(`Line ${i + 1}: ${p.error.issues[0]?.message ?? "check this line."}`);
    lines.push({ description: p.data.description, quantity: p.data.quantity, unitCents: p.data.price });
  }
  const discountCents = blank(values.discount) ? 0 : fieldMoney(values.discount);
  if (discountCents === null) return fail("Enter the discount as an amount in rand, for example 100 or 100,00.");
  const dueDate = (values.dueDate ?? "").trim();
  if (!isRealDate(dueDate)) return fail("Choose a due date.");
  if (dueDate < today) return fail("The due date cannot be in the past.");
  const payer = z.enum(PAYER_TYPES).safeParse(values.payer);
  if (!payer.success) return fail("Choose who pays: the patient, the medical aid, or both.");
  let schemeCents: number | null = null;
  if (payer.data === "split") {
    schemeCents = fieldMoney(values.scheme);
    if (schemeCents === null || blank(values.scheme)) return fail("Enter the medical aid portion in rand, for example 600 or 600,00.");
  }
  return { ok: true, value: { lines, discountCents, dueDate, payer: payer.data, schemeCents } };
}

export type BuiltInvoice = {
  subtotal: number; discount: number; vat: number; total: number; scheme: number; patientPortion: number;
  lines: { description: string; quantity: number; unit_cents: number }[];
};

/**
 * Server-side figures for a parsed form: subtotal, discount, VAT and total from computeInvoice (VAT-exclusive prices, practice VAT settings),
 * and the two portions, which always add up to the total:
 *   self -> patient pays all; medical_aid -> the scheme is billed all; split -> scheme portion typed, patient portion = total - scheme.
 */
export function buildInvoice(input: InvoiceFormInput, vat: { registered: boolean; rate: number }): Result<BuiltInvoice> {
  let c: ReturnType<typeof computeInvoice>;
  const subtotal = input.lines.reduce((s, l) => s + l.quantity * l.unitCents, 0);
  if (input.discountCents > subtotal) return fail(`The discount cannot be more than the subtotal (${formatZar(subtotal)}).`);
  try { c = computeInvoice({ lines: input.lines, discountCents: input.discountCents, vatRegistered: vat.registered, vatRate: vat.rate }); }
  catch { return fail("These amounts are too large for one invoice. Check the quantities and prices."); }
  let scheme = 0;
  if (input.payer === "medical_aid") scheme = c.total;
  else if (input.payer === "split") {
    scheme = input.schemeCents ?? 0;
    if (scheme <= 0 || scheme >= c.total) return fail(`For a split invoice the medical aid portion must be more than R 0,00 and less than the invoice total (${formatZar(c.total)}).`);
  }
  return {
    ok: true,
    value: {
      subtotal: c.subtotal, discount: c.discount, vat: c.vat, total: c.total, scheme, patientPortion: c.total - scheme,
      lines: input.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_cents: l.unitCents })),
    },
  };
}

// ---- payments and credit notes ---------------------------------------------------------------------------------------------
const tick = (v: unknown) => v === "on" || v === "true";

export type PaymentInput = { method: ManualMethod; amountCents: number; reference: string | null; receivedOn: string; allowDuplicate: boolean };

/** Parse the manual payment form. `today` is the SAST date: a received date in the future is refused here and again by the database. */
export function parsePaymentForm(values: Values, today: string): Result<PaymentInput> {
  const method = z.enum(MANUAL_METHODS).safeParse(values.method);
  if (!method.success) return fail("Choose how the payment was made: EFT, cash or card machine.");
  const amountCents = fieldMoney(values.amount);
  if (amountCents === null || amountCents <= 0) return fail("Enter the amount received in rand, for example 950 or 950,00.");
  const ref = (values.reference ?? "").trim();
  if (ref.length > 100) return fail("Keep the reference under 100 characters.");
  if (method.data !== "cash" && ref === "") return fail(method.data === "eft" ? "Enter the bank reference of the EFT." : "Enter the card slip or receipt number.");
  const receivedOn = (values.receivedOn ?? "").trim();
  if (!isRealDate(receivedOn)) return fail("Choose the date the payment was received.");
  if (receivedOn > today) return fail("The date received cannot be in the future.");
  return { ok: true, value: { method: method.data, amountCents, reference: ref === "" ? null : ref, receivedOn, allowDuplicate: tick(values.allowDuplicate) } };
}

export type CreditNoteInput = { amountCents: number; reason: string };
export function parseCreditNoteForm(values: Values): Result<CreditNoteInput> {
  const amountCents = fieldMoney(values.amount);
  if (amountCents === null || amountCents <= 0) return fail("Enter the credit amount in rand, for example 150 or 150,00.");
  const reason = (values.reason ?? "").trim();
  if (reason === "") return fail("Give a reason for the credit note.");
  if (reason.length > 300) return fail("Keep the reason under 300 characters.");
  return { ok: true, value: { amountCents, reason } };
}
