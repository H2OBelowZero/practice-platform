import { isOverdue, METHOD_LABEL } from "@/lib/billing/list";
import { payNowAllowed, type PayNow } from "@/lib/billing/pay-now";
import { formatZar } from "@/lib/money";
import { sastDayShort } from "@/lib/time";

// Pure helpers behind the patient / guardian Payments pages (13c). No database or framework code here, so all of it is unit tested.
// Money is integer cents throughout; the database is the authority and every figure arrives from rows read through RLS.

export const PAY_ONLINE_UNAVAILABLE = "Online payment is not available right now — please pay by EFT or contact the practice.";
export const SCHEME_PENDING_TEXT = "Your medical aid is still processing its part of this invoice — you'll be able to pay your portion once it has been settled.";
export const DEFAULT_PAYMENT_INSTRUCTIONS = "Please contact the practice for EFT details.";

export const NOT_YET_TEXT = "This invoice can't be paid online yet. Please contact the practice if you have any questions.";
/**
 * The friendly "your medical aid is still processing" sentence is true for a while after an invoice is issued, but the portal cannot see claims
 * (staff only), so it cannot tell a claim in progress from one that will never settle by itself (rejected, never submitted, written off elsewhere).
 * Decision: friendly wording for the first SCHEME_WAIT_DAYS days after the issue date, a neutral "contact the practice" sentence after that.
 */
export const SCHEME_WAIT_DAYS = 60;
const daysBetween = (from: string, to: string) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Plain-language reason a "Pay now" button is not offered. `ctx` (issue date and today, YYYY-MM-DD) switches the medical aid wording by invoice age. */
export function payNowReasonText(reason: PayNow["reason"] | undefined, ctx?: { issueDate: string; today: string }): string {
  if (reason === "scheme_pending") return ctx && daysBetween(ctx.issueDate, ctx.today) > SCHEME_WAIT_DAYS ? NOT_YET_TEXT : SCHEME_PENDING_TEXT;
  if (reason === "paid") return "This invoice has been paid.";
  return "This invoice cannot be paid online.";
}

export type InvoiceRow = {
  id: string; number: string; patient_id: string; status: string; payer_type: string; issue_date: string; due_date: string;
  total_cents: number; scheme_portion_cents: number; patient_portion_cents: number; outstanding_cents: number;
};
export type PaymentRow = { id: string; invoice_id: string; method: string; amount_cents: number; received_on: string };
export type CreditRow = { invoice_id: string; portion: string; amount_cents: number };
export type PatientRow = { id: string; first_name: string; user_id: string | null };

export type PortalInvoice = {
  id: string; number: string; status: string; payerType: string; issueDate: string; dueDate: string;
  totalCents: number; outstandingCents: number; overdue: boolean; open: boolean;
  /** first name of the person the invoice is for when that is not the signed-in user (a guardian's child), else null */
  forName: string | null;
  payNow: PayNow;
  /** why there is no Pay now button on an open invoice (null when it is payable or not open) */
  noPayText: string | null;
};

/** True for an invoice that can still be paid (issued or part paid). */
export const isOpenStatus = (status: string): boolean => status === "issued" || status === "part_paid";

/**
 * One view per invoice: the payNowAllowed verdict is computed here from the payments and credit notes read through RLS (R39/R40).
 * `outstandingCents` is the database's own figure (invoice_balances), 0 for anything that is not open. Draft invoices are dropped.
 */
export function buildPortalInvoices(o: {
  invoices: InvoiceRow[]; payments: PaymentRow[]; credits: CreditRow[]; patients: PatientRow[]; userId: string; today: string;
}): PortalInvoice[] {
  const who = new Map(o.patients.map((p) => [p.id, p]));
  return o.invoices.filter((i) => i.status !== "draft").map((i) => {
    const pays = o.payments.filter((p) => p.invoice_id === i.id).map((p) => ({ method: p.method, amountCents: p.amount_cents }));
    const credits = o.credits.filter((c) => c.invoice_id === i.id).map((c) => ({ portion: c.portion, amountCents: c.amount_cents }));
    const payNow = payNowAllowed({
      status: i.status, payerType: i.payer_type, totalCents: i.total_cents, schemePortionCents: i.scheme_portion_cents, patientPortionCents: i.patient_portion_cents,
      credits, payments: pays,
    });
    const p = who.get(i.patient_id);
    return {
      id: i.id, number: i.number, status: i.status, payerType: i.payer_type, issueDate: i.issue_date, dueDate: i.due_date,
      totalCents: i.total_cents, outstandingCents: isOpenStatus(i.status) ? i.outstanding_cents : 0, overdue: isOverdue(i, o.today), open: isOpenStatus(i.status),
      forName: p && p.user_id !== o.userId ? p.first_name : null, payNow,
      noPayText: isOpenStatus(i.status) && !payNow.allowed ? payNowReasonText(payNow.reason, { issueDate: i.issue_date, today: o.today }) : null,
    };
  });
}

/** Open invoices first (soonest due first), then the rest, newest first. */
export function orderInvoices(list: PortalInvoice[]): { open: PortalInvoice[]; closed: PortalInvoice[] } {
  const open = list.filter((i) => i.open).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number));
  const closed = list.filter((i) => !i.open).sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.number.localeCompare(a.number));
  return { open, closed };
}

/**
 * The headline figures: everything outstanding on open invoices, how much of that can be paid online right now, and how much is waiting
 * for the medical aid (not payable online yet). payableNow + awaitingScheme <= outstanding.
 */
export function summarise(list: PortalInvoice[]) {
  let outstanding = 0, payableNow = 0, awaitingScheme = 0;
  for (const i of list) {
    if (!i.open) continue;
    outstanding += i.outstandingCents;
    if (i.payNow.allowed) payableNow += i.payNow.amountCents;
    else if (i.payNow.reason === "scheme_pending") awaitingScheme += i.outstandingCents;
  }
  return { outstandingCents: outstanding, payableNowCents: payableNow, awaitingSchemeCents: awaitingScheme, openCount: list.filter((i) => i.open).length };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The `?paid=` value of the PayFast return URL: a uuid or nothing. It only selects which invoice to highlight, nothing is trusted from it. */
export function parsePaidParam(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
}

export type ReturnState = "none" | "confirming" | "paid";
/**
 * What the PayFast return page says, from STORED data only: "paid" when the invoice is paid or a PayFast payment row exists,
 * "confirming" while neither is there yet (the ITN has not arrived), "none" when the invoice is not one the user can see.
 */
export function returnState(inv: { status: string } | undefined, payments: { method: string }[]): ReturnState {
  if (!inv) return "none";
  return inv.status === "paid" || payments.some((p) => p.method === "payfast") ? "paid" : "confirming";
}
/**
 * The PayFast return URL names the invoice that was just paid. While it is still unpaid in our records (the ITN has not arrived) and also once it
 * is paid, that invoice shows no Pay now: offering it again invites a second payment. Other invoices are unaffected.
 */
export const hidePayNow = (paidId: string | null, invoiceId: string, state: ReturnState): boolean => paidId !== null && paidId === invoiceId && state !== "none";

export const RECENT_CHECKOUT_MINUTES = 10;
/** The earliest instant that still counts as "started a moment ago". */
export const recentCheckoutCutoff = (now: Date): string => new Date(now.getTime() - RECENT_CHECKOUT_MINUTES * 60_000).toISOString();
export const CHECKOUT_RECENT_TEXT = "A payment for this invoice was just started. Please wait a few minutes for confirmation.";

export const RETURN_TEXT = {
  confirming: "We're confirming your payment. This usually takes a minute; refresh this page.",
  paid: "Paid, thank you.",
} as const;

/** How a credit note is described to the patient. The staff's free-text reason is never read for the portal. */
export const creditText = (portion: string): string =>
  portion === "scheme" ? "Amount your medical aid did not cover, written off" : "Discount or write-off";

/** First name for the PayFast form from the verified user's display name; the email as given. Empty values are left out of the form by buildCheckout. */
export function checkoutIdentity(displayName: string | null | undefined, email: string | null | undefined): { name: string; email: string } {
  return { name: (displayName ?? "").trim().split(/\s+/)[0] ?? "", email: (email ?? "").trim() };
}

export type CheckoutDecision =
  | { ok: true; amountCents: number; number: string }
  | { ok: false; error: string; code: "not_found" | "paid" | "not_payable" | "scheme_pending" | "stale" };

/**
 * Decide, server side, whether a PayFast checkout may start and for how much. The amount is ALWAYS the outstanding balance computed from the
 * rows read through RLS. `seenCents` (what the page showed the user) is never used as the amount: if it differs from the current balance the
 * checkout is refused so nobody pays a figure they did not see.
 */
export function decideCheckout(o: {
  invoice: { number: string; status: string; payer_type: string; total_cents: number; scheme_portion_cents: number; patient_portion_cents: number; issue_date?: string } | null;
  payments: { method: string; amountCents: number }[]; credits: { portion: string; amountCents: number }[]; seenCents?: number; today?: string;
}): CheckoutDecision {
  const inv = o.invoice;
  if (!inv || inv.status === "draft") return { ok: false, code: "not_found", error: "We could not find that invoice." };
  const v = payNowAllowed({
    status: inv.status, payerType: inv.payer_type, totalCents: inv.total_cents, schemePortionCents: inv.scheme_portion_cents,
    patientPortionCents: inv.patient_portion_cents, credits: o.credits, payments: o.payments,
  });
  if (!v.allowed) return { ok: false, code: v.reason ?? "not_payable", error: payNowReasonText(v.reason, inv.issue_date && o.today ? { issueDate: inv.issue_date, today: o.today } : undefined) };
  if (o.seenCents !== undefined && o.seenCents !== v.amountCents) {
    return { ok: false, code: "stale", error: `The amount on this invoice has changed (it is now ${formatZar(v.amountCents)}). Please refresh the page and check it before paying.` };
  }
  return { ok: true, amountCents: v.amountCents, number: inv.number };
}

export type ReceiptView = {
  practiceName: string; practiceNumber: string | null; hpcsaNumber: string | null; invoiceNumber: string; patientName: string | null;
  dateReceived: string; method: string; reference: string | null; amount: string; vatNote: string;
};
/** Everything printed on a payment receipt, as display strings (same wording as the staff receipt). */
export function receiptView(o: {
  practice: { name: string; registration_no: string | null; hpcsa_no: string | null } | null;
  invoice: { number: string; total_cents: number; vat_cents: number };
  patient: { first_name: string; last_name: string } | null;
  payment: { method: string; amount_cents: number; received_on: string; reference: string | null; gateway_ref: string | null };
}): ReceiptView {
  const { invoice, payment } = o;
  return {
    practiceName: o.practice?.name || "Practice", practiceNumber: o.practice?.registration_no || null, hpcsaNumber: o.practice?.hpcsa_no || null,
    invoiceNumber: invoice.number, patientName: o.patient ? `${o.patient.first_name} ${o.patient.last_name}`.trim() : null,
    dateReceived: sastDayShort(payment.received_on, true), method: METHOD_LABEL[payment.method] ?? payment.method,
    reference: payment.reference ?? payment.gateway_ref ?? null, amount: formatZar(payment.amount_cents),
    vatNote: invoice.vat_cents > 0
      ? `Invoice ${invoice.number} totals ${formatZar(invoice.total_cents)}, which includes VAT of ${formatZar(invoice.vat_cents)}.`
      : `No VAT is charged on invoice ${invoice.number}.`,
  };
}

/** A payment the patient made themselves (not the scheme's remittance) has a receipt in the portal. */
export const hasPortalReceipt = (method: string): boolean => method !== "medical_aid";
