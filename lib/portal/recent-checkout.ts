import "server-only";
import { supabaseService } from "@/lib/supabase/service";
import { recentCheckoutCutoff } from "./payments";

/**
 * Advisory double-payment guard: did THIS user start a PayFast checkout for THIS invoice in the last RECENT_CHECKOUT_MINUTES?
 * Source: the audit rows `payment.checkout_started` that startPayfastCheckout writes (so no extra table). audit_log is readable by the psychologist
 * only, hence the service client; only ids are selected (`id`), filtered by the verified user id, the action, the invoice id and the time.
 *
 * Fails OPEN on purpose: any error answers "no", because a failed lookup must never block a payment. It is only a nudge for the common
 * "clicked Pay, came back, clicked again" case. It is not the control: two real payments are reconciled by the ITN (R37).
 * Known limits: the audit row is written best effort (a failed audit write means no guard), and a person who cancels at PayFast and wants to retry
 * has to wait the window out or pay by EFT.
 */
export async function startedRecently(userId: string, invoiceId: string, now = new Date()): Promise<boolean> {
  try {
    const { data, error } = await supabaseService().from("audit_log").select("id")
      .eq("actor_id", userId).eq("action", "payment.checkout_started").eq("entity_id", invoiceId).gte("at", recentCheckoutCutoff(now)).limit(1);
    if (error) return false;
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
