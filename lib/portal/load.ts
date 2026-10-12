import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPortalInvoices, type CreditRow, type InvoiceRow, type PatientRow, type PaymentRow } from "./payments";

const INVOICE_COLS = "id, number, patient_id, status, payer_type, issue_date, due_date, total_cents, scheme_portion_cents, patient_portion_cents, outstanding_cents";

const fail = (what: string, e: { code?: string; message: string }): never => { throw new Error(`portal payments ${what}: ${e.code ?? ""} ${e.message}`); };

/**
 * Everything the portal Payments pages show, read with the SIGNED-IN USER'S client, so RLS decides what arrives: a patient gets their own issued
 * invoices, a guardian those of the children they may pay for (permissions.pay), nobody else's. Drafts are filtered out as well (the policies hide
 * them already). Any read error throws: the page must not show a balance it could not verify.
 */
export async function loadPortalPayments(sb: SupabaseClient, userId: string, today: string) {
  const inv = await sb.from("invoice_balances").select(INVOICE_COLS).neq("status", "draft").order("issue_date", { ascending: false }).limit(200);
  if (inv.error) fail("invoices", inv.error);
  const invoices = (inv.data ?? []) as unknown as InvoiceRow[];
  const ids = invoices.map((i) => i.id);

  const [pay, cr, pat] = ids.length === 0 ? [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }] : await Promise.all([
    sb.from("payments").select("id, invoice_id, method, amount_cents, received_on").in("invoice_id", ids).eq("status", "succeeded").order("received_on", { ascending: false }).order("created_at", { ascending: false }),
    sb.from("credit_notes").select("invoice_id, portion, amount_cents").in("invoice_id", ids),
    sb.from("patients").select("id, first_name, user_id").in("id", [...new Set(invoices.map((i) => i.patient_id))]),
  ]);
  if (pay.error) fail("payments", pay.error);
  if (cr.error) fail("credits", cr.error);
  if (pat.error) fail("people", pat.error);
  const payments = (pay.data ?? []) as unknown as PaymentRow[];
  const credits = (cr.data ?? []) as unknown as CreditRow[];
  const patients = (pat.data ?? []) as unknown as PatientRow[];

  return { list: buildPortalInvoices({ invoices, payments, credits, patients, userId, today }), payments, invoices };
}

/** The pieces of ONE invoice that the checkout decision needs, read through RLS (null when the user cannot see it). */
export async function loadInvoiceForCheckout(sb: SupabaseClient, invoiceId: string) {
  const inv = await sb.from("invoices")
    .select("id, number, patient_id, status, payer_type, issue_date, total_cents, scheme_portion_cents, patient_portion_cents").eq("id", invoiceId).neq("status", "draft").maybeSingle();
  if (inv.error) fail("invoice", inv.error);
  if (!inv.data) return null;
  const [pay, cr] = await Promise.all([
    sb.from("payments").select("method, amount_cents").eq("invoice_id", invoiceId).eq("status", "succeeded"),
    sb.from("credit_notes").select("portion, amount_cents").eq("invoice_id", invoiceId),
  ]);
  if (pay.error) fail("payments", pay.error);
  if (cr.error) fail("credits", cr.error);
  return {
    invoice: inv.data as unknown as { id: string; number: string; patient_id: string; status: string; payer_type: string; issue_date: string; total_cents: number; scheme_portion_cents: number; patient_portion_cents: number },
    payments: (pay.data ?? []).map((p) => ({ method: String(p.method), amountCents: Number(p.amount_cents) })),
    credits: (cr.data ?? []).map((c) => ({ portion: String(c.portion), amountCents: Number(c.amount_cents) })),
  };
}
