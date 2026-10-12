"use server";

import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { safely } from "@/lib/appointments/followups";
import { buildCheckout, payfastAvailable } from "@/lib/payments/payfast";
import { checkoutIdentity, CHECKOUT_RECENT_TEXT, decideCheckout, PAY_ONLINE_UNAVAILABLE } from "@/lib/portal/payments";
import { startedRecently } from "@/lib/portal/recent-checkout";
import { sastDate } from "@/lib/time";
import { loadInvoiceForCheckout } from "@/lib/portal/load";
import { supabaseServer } from "@/lib/supabase/server";

export type CheckoutResult =
  | { ok: true; action: string; fields: Record<string, string> }
  | { ok: false; error: string };

const GENERIC = "Something went wrong and nothing was charged. Please try again, or contact the practice.";
const invoiceId = z.uuid();
const seen = z.number().int().positive().max(2_147_483_647).optional();

/**
 * Start a PayFast payment for one invoice. Everything that matters is decided here, on the server:
 *  - the caller must be a signed-in patient or guardian (requireRole -> requireUser, R26);
 *  - the invoice, its payments and its credit notes are read through the CALLER'S client, so RLS decides whether it is theirs
 *    (a guardian also needs permissions.pay) and the amount comes from those rows, never from the client;
 *  - payNowAllowed() is recomputed (self-pay always, medical aid / split only once the scheme side is settled, R40);
 *  - a checkout this user started for this invoice in the last 10 minutes (audit rows, see lib/portal/recent-checkout.ts) is refused with a friendly
 *    message; that guard is advisory and fails open, the ITN reconciles any real duplicate (R37);
 *  - the PayFast name and email are the VERIFIED user's own (auth.getUser() and their profile), for a guardian the guardian's, not the child's.
 * `seenCents` is only what the page displayed: if it no longer matches the balance the checkout is refused. It is never charged.
 * Returns the PayFast form (action URL + signed fields) for the page to POST; money is only ever recorded by the signed ITN.
 */
export async function startPayfastCheckout(rawInvoiceId: unknown, rawSeenCents?: unknown): Promise<CheckoutResult> {
  const me = await requireRole(["patient", "guardian"]);
  const id = invoiceId.safeParse(rawInvoiceId);
  const seenCents = seen.safeParse(rawSeenCents);
  if (!id.success || !seenCents.success) return { ok: false, error: GENERIC };

  try {
    const sb = await supabaseServer();
    const loaded = await loadInvoiceForCheckout(sb, id.data);
    const decision = decideCheckout({ invoice: loaded?.invoice ?? null, payments: loaded?.payments ?? [], credits: loaded?.credits ?? [], seenCents: seenCents.data, today: sastDate(new Date()) });
    if (!decision.ok) return { ok: false, error: decision.error };
    // advisory only (fails open): the same user started a checkout for this invoice a moment ago, so the first payment is probably still being confirmed
    if (await startedRecently(me.userId, id.data)) return { ok: false, error: CHECKOUT_RECENT_TEXT };
    if (!payfastAvailable()) return { ok: false, error: PAY_ONLINE_UNAVAILABLE };

    const { data: { user } } = await sb.auth.getUser(); // validated by the Auth server, not the cookie
    if (!user || user.id !== me.userId) return { ok: false, error: GENERIC };
    const { data: profile } = await sb.from("profiles").select("display_name").eq("user_id", me.userId).maybeSingle();
    const who = checkoutIdentity(profile?.display_name as string | undefined, user.email);

    let checkout: { action: string; fields: Record<string, string> };
    try {
      checkout = buildCheckout({ invoiceId: id.data, number: decision.number, amountCents: decision.amountCents, name: who.name, email: who.email });
    } catch (e) {
      console.error("payfast checkout not built:", e instanceof Error ? e.message : "unknown"); // misconfiguration: never show the text to the patient
      return { ok: false, error: PAY_ONLINE_UNAVAILABLE };
    }
    await safely("payment.checkout_started", () => audit("payment.checkout_started", "invoices", id.data, { invoice_id: id.data, amount_cents: decision.amountCents }));
    return { ok: true, ...checkout };
  } catch (e) {
    console.error("startPayfastCheckout failed:", e instanceof Error ? e.message : "unknown");
    return { ok: false, error: GENERIC };
  }
}
