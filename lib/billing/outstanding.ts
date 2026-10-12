import type { SupabaseClient } from "@supabase/supabase-js";

/** What is still owed on an invoice: total - credit notes - payments, never below zero. All integer cents. */
export function outstandingCents(o: { totalCents: number; creditCents: number; paidCents: number }): number {
  return Math.max(0, o.totalCents - o.creditCents - o.paidCents);
}

export type InvoiceBalance = {
  invoiceId: string; status: string; totalCents: number; creditCents: number; paidCents: number; outstandingCents: number;
};

/**
 * Read an invoice's balance with any Supabase client (the PayFast ITN route passes the SERVICE client: no user session there).
 * paid comes from the invoice_paid_cents RPC (succeeded payments only), credit from the credit_notes rows.
 * Returns null when the invoice does not exist; throws on any DB error (the caller must not guess a balance).
 * The three reads are not one snapshot; the payments_guard trigger is the final authority when money is recorded.
 */
export async function loadOutstanding(client: SupabaseClient, invoiceId: string): Promise<InvoiceBalance | null> {
  const inv = await client.from("invoices").select("id,status,total_cents").eq("id", invoiceId).maybeSingle();
  if (inv.error) throw new Error(`loadOutstanding invoice: ${inv.error.code ?? ""} ${inv.error.message}`);
  if (!inv.data) return null;
  const cr = await client.from("credit_notes").select("amount_cents").eq("invoice_id", invoiceId);
  if (cr.error) throw new Error(`loadOutstanding credits: ${cr.error.code ?? ""} ${cr.error.message}`);
  const paid = await client.rpc("invoice_paid_cents", { p_invoice: invoiceId });
  if (paid.error) throw new Error(`loadOutstanding paid: ${paid.error.code ?? ""} ${paid.error.message}`);
  const totalCents = Number(inv.data.total_cents);
  const creditCents = (cr.data ?? []).reduce((s: number, r: { amount_cents: number }) => s + Number(r.amount_cents), 0);
  const paidCents = Number(paid.data ?? 0);
  return { invoiceId, status: String(inv.data.status), totalCents, creditCents, paidCents, outstandingCents: outstandingCents({ totalCents, creditCents, paidCents }) };
}
