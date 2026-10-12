"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import type { ActionState, Values } from "@/lib/appointments/types";
import { safely } from "@/lib/appointments/followups";
import { BILLING_ERROR, billingErrorCode, billingErrorText } from "@/lib/billing/errors";
import { shouldShowExistingInvoice } from "@/lib/billing/fee-tasks";
import { billingRecipient, queueBillingEmail } from "@/lib/billing/followups";
import { buildInvoice, parseCreditNoteForm, parseInvoiceForm, parsePaymentForm, uuid } from "@/lib/billing/input";
import { loadOutstanding } from "@/lib/billing/outstanding";
import { getBillingPractice } from "@/lib/billing/practice";
import type { PayState } from "@/lib/billing/types";
import { formatZar } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";

// Staff billing actions. Every one calls requireRole itself (R26), validates with Zod, and writes through the signed-in user's own client,
// so RLS and the 0005/0015 rules decide. The forms never send totals: the server computes every figure. Success redirects.
const WRITERS = ["psychologist", "admin"] as const;
const generic = { error: BILLING_ERROR.generic } as const;
const detail = (id: string, notice: string): never => redirect(`/app/billing/${id}?notice=${notice}`);

const createCtx = z.object({ patientId: uuid, appointmentId: uuid.optional(), taskId: uuid.optional() });

/** Compute the figures for a submitted invoice form with the practice VAT settings; an error is the message to show. */
async function figures(values: Values) {
  const parsed = parseInvoiceForm(values, sastDate(new Date()));
  if (!parsed.ok) return parsed;
  const practice = await getBillingPractice();
  if (!practice) return { ok: false as const, error: BILLING_ERROR.generic, field: undefined };
  const built = buildInvoice(parsed.value, { registered: practice.vat_registered, rate: practice.vat_rate });
  return built.ok ? { ok: true as const, value: built.value, input: parsed.value } : built;
}

/**
 * Create a DRAFT invoice (manual, from an attended appointment, or from a late-cancellation fee task) with all its lines in one transaction
 * (create_invoice_draft, 0015). From a fee task the database closes the task in the same transaction. One live invoice per appointment:
 * if there already is one, go to it.
 */
export async function createInvoice(rawCtx: unknown, values: Values): Promise<ActionState> {
  await requireRole([...WRITERS]);
  const ctx = createCtx.safeParse(rawCtx);
  if (!ctx.success) return generic;
  const built = await figures(values);
  if (!built.ok) return { error: built.error, field: built.field };
  const b = built.value;

  const sb = await supabaseServer();
  const { data, error } = await sb.rpc("create_invoice_draft", {
    p_patient: ctx.data.patientId, p_appointment: ctx.data.appointmentId ?? null, p_task: ctx.data.taskId ?? null,
    p_due: built.input.dueDate, p_payer: built.input.payer,
    p_subtotal: b.subtotal, p_discount: b.discount, p_vat: b.vat, p_total: b.total, p_scheme: b.scheme, p_patient_portion: b.patientPortion, p_lines: b.lines,
  });
  if (error || typeof data !== "string") {
    if (shouldShowExistingInvoice(billingErrorCode(error?.message), !!ctx.data.appointmentId) && ctx.data.appointmentId) {
      const { data: live } = await sb.from("invoices").select("id").eq("appointment_id", ctx.data.appointmentId).neq("status", "void").maybeSingle();
      if (live?.id) return detail(live.id as string, "exists");
    }
    return { error: billingErrorText(error?.message) };
  }
  await safely("invoice.create", () => audit("invoice.create", "invoices", data, { patient_id: ctx.data.patientId, appointment_id: ctx.data.appointmentId ?? null, task_id: ctx.data.taskId ?? null }));
  return detail(data, "created");
}

/** Replace a draft's lines, due date, payer, discount and portions (recomputed here). The database refuses anything but a draft. */
export async function saveDraft(rawId: unknown, values: Values): Promise<ActionState> {
  await requireRole([...WRITERS]);
  const id = uuid.safeParse(rawId);
  if (!id.success) return generic;
  const built = await figures(values);
  if (!built.ok) return { error: built.error, field: built.field };
  const b = built.value;

  const sb = await supabaseServer();
  const { error } = await sb.rpc("save_invoice_draft", {
    p_invoice: id.data, p_due: built.input.dueDate, p_payer: built.input.payer,
    p_subtotal: b.subtotal, p_discount: b.discount, p_vat: b.vat, p_total: b.total, p_scheme: b.scheme, p_patient_portion: b.patientPortion, p_lines: b.lines,
  });
  if (error) return { error: billingErrorText(error.message) };
  await safely("invoice.update", () => audit("invoice.update", "invoices", id.data));
  return detail(id.data, "saved");
}

/** draft -> issued. The database checks the portions and the total, stamps issue_date and audits it; then the patient is emailed a link. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function issueInvoice(rawId: unknown, _values?: Values): Promise<ActionState> { // _values: submitted by the confirmation form, unused
  await requireRole([...WRITERS]);
  const id = uuid.safeParse(rawId);
  if (!id.success) return generic;
  const sb = await supabaseServer();
  const { data, error } = await sb.from("invoices").update({ status: "issued" }).eq("id", id.data).eq("status", "draft").select("id, patient_id");
  if (error) return { error: billingErrorText(error.message) };
  if (!data?.length) return { error: BILLING_ERROR.invoice_not_draft };
  const patientId = data[0].patient_id as string;
  await safely("invoice_issued email", async () => queueBillingEmail("invoice_issued", await billingRecipient(sb, patientId)));
  return detail(id.data, "issued");
}

/** draft or issued -> void. The database refuses an invoice with payments or with a submitted / paid claim. */
export async function voidInvoice(rawId: unknown): Promise<ActionState> {
  await requireRole([...WRITERS]);
  const id = uuid.safeParse(rawId);
  if (!id.success) return generic;
  const sb = await supabaseServer();
  const { data, error } = await sb.from("invoices").update({ status: "void" }).eq("id", id.data).in("status", ["draft", "issued"]).select("id");
  if (error) return { error: billingErrorText(error.message) };
  if (!data?.length) {
    // not a draft or issued invoice: say why (part paid and paid invoices have payments)
    const { data: cur } = await sb.from("invoices").select("status").eq("id", id.data).maybeSingle();
    return { error: cur?.status === "void" ? BILLING_ERROR.invoice_void_is_final : cur ? BILLING_ERROR.invoice_has_payments : BILLING_ERROR.unknown_invoice };
  }
  return detail(id.data, "voided");
}

/**
 * Record an EFT, cash or card machine payment through record_payment (recorded_by is the signed-in user; the DB audits it).
 * possible_duplicate comes back as { duplicate: true } so the form can offer "Record anyway", which resends with allowDuplicate.
 */
export async function recordPayment(rawId: unknown, values: Values): Promise<PayState> {
  await requireRole([...WRITERS]);
  const id = uuid.safeParse(rawId);
  if (!id.success) return generic;
  const p = parsePaymentForm(values, sastDate(new Date()));
  if (!p.ok) return { error: p.error, field: p.field };

  const sb = await supabaseServer();
  const bal = await loadOutstanding(sb, id.data).catch(() => undefined);
  if (bal === undefined) return generic;
  if (!bal) return { error: BILLING_ERROR.unknown_invoice };
  if (bal.status !== "issued" && bal.status !== "part_paid") return { error: BILLING_ERROR.invoice_not_payable };
  if (p.value.amountCents > bal.outstandingCents) return { error: `That is more than the invoice still owes (${formatZar(bal.outstandingCents)}).`, field: "amount" };

  const { error } = await sb.rpc("record_payment", {
    p_invoice: id.data, p_method: p.value.method, p_amount: p.value.amountCents, p_ref: p.value.reference, p_by: null,
    p_received_on: p.value.receivedOn, p_allow_duplicate: p.value.allowDuplicate,
  });
  if (error) {
    const code = billingErrorCode(error.message);
    return code === "possible_duplicate" ? { error: BILLING_ERROR.possible_duplicate, duplicate: true } : { error: billingErrorText(error.message) };
  }
  await safely("payment_receipt email", async () => {
    const { data: inv } = await sb.from("invoices").select("patient_id").eq("id", id.data).maybeSingle();
    if (inv?.patient_id) await queueBillingEmail("payment_receipt", await billingRecipient(sb, inv.patient_id as string));
  });
  return detail(id.data, "payment");
}

/** A credit note: psychologist only (RLS and the guard trigger say so too). The amount cannot exceed what is still owed. */
export async function addCreditNote(rawId: unknown, values: Values): Promise<ActionState> {
  await requireRole(["psychologist"]);
  const id = uuid.safeParse(rawId);
  if (!id.success) return generic;
  const c = parseCreditNoteForm(values);
  if (!c.ok) return { error: c.error, field: c.field };

  const sb = await supabaseServer();
  const bal = await loadOutstanding(sb, id.data).catch(() => undefined);
  if (bal === undefined) return generic;
  if (!bal) return { error: BILLING_ERROR.unknown_invoice };
  if (bal.status !== "issued" && bal.status !== "part_paid") return { error: BILLING_ERROR.invoice_not_creditable };
  if (c.value.amountCents > bal.outstandingCents) return { error: `A credit note cannot be more than what is still owed (${formatZar(bal.outstandingCents)}).`, field: "amount" };

  const { error } = await sb.from("credit_notes").insert({ invoice_id: id.data, amount_cents: c.value.amountCents, reason: c.value.reason });
  if (error) return { error: billingErrorText(error.message) };
  return detail(id.data, "credit");
}
