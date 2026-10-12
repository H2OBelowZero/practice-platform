import "server-only";
import { appUrl } from "@/lib/app-url";
import { supabaseService } from "@/lib/supabase/service";

export type FormEmailTemplate = "form_requested" | "form_returned";

/**
 * Queue a short email for the notification worker (Task 15): "you have a form waiting" / "a form was returned". The payload is the link to the
 * portal documents page ONLY: no form name, no note, no patient name. Written with the service client (the outbox is service-role only).
 * Never throws: the form change has already happened, so a failure is logged (code only) and reported as false.
 */
export async function queueFormEmail(template: FormEmailTemplate, recipient: string | null | undefined): Promise<boolean> {
  if (!recipient) return false;
  try {
    const { error } = await supabaseService().from("notifications_outbox").insert({
      channel: "email", template, recipient, payload: { link: `${appUrl()}/portal/documents` },
    });
    if (error) { console.error(`${template} not queued:`, error.code); return false; }
    return true;
  } catch (e) { console.error(`${template} not queued:`, e instanceof Error ? e.message : "unknown"); return false; }
}
