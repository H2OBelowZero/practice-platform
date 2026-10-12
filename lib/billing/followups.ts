import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "@/lib/app-url";
import { supabaseService } from "@/lib/supabase/service";

export type BillingTemplate = "invoice_issued" | "payment_receipt";

/** The link in a billing email: the portal payments page, or registration first (returning to it) when the patient has no portal account. */
export const billingLink = (base: string, hasPortal: boolean): string =>
  hasPortal ? `${base}/portal/payments` : `${base}/register?next=/portal/payments`;

/**
 * Recipient rule (same as the calendar emails): patients.email, read with the staff user's own (RLS) client, and only when
 * comms_prefs.email is true. Also says whether the patient has a portal account (patients.user_id), which decides the link.
 */
export async function billingRecipient(sb: SupabaseClient, patientId: string): Promise<{ email: string; hasPortal: boolean } | null> {
  const { data } = await sb.from("patients").select("email, comms_prefs, user_id").eq("id", patientId).maybeSingle();
  const prefs = data?.comms_prefs as { email?: boolean } | null | undefined;
  return data?.email && prefs?.email === true ? { email: data.email as string, hasPortal: !!data.user_id } : null;
}

/**
 * Queue an invoice_issued / payment_receipt email for the notification worker. The payload is the link ONLY: no amounts, no names, no
 * invoice number. Written with the service client (the outbox is service-role only). Never throws: the money change has already happened,
 * so a failure here is logged (code only) and must not make the user think it failed.
 */
export async function queueBillingEmail(template: BillingTemplate, recipient: { email: string; hasPortal: boolean } | null): Promise<void> {
  if (!recipient) return;
  try {
    const { error } = await supabaseService().from("notifications_outbox").insert({
      channel: "email", template, recipient: recipient.email, payload: { link: billingLink(appUrl(), recipient.hasPortal) },
    });
    if (error) console.error(`${template} not queued:`, error.code);
  } catch (e) { console.error(`${template} not queued:`, e instanceof Error ? e.message : "unknown"); }
}
