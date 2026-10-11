import "server-only";
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/server";

/** Used when the practice row cannot be read (anonymous visitors: practices is readable by signed-in users only). */
export const DEFAULT_CRISIS_TEXT =
  "If you are in crisis call SADAG 0800 567 567 or go to the nearest emergency room. This platform is not an emergency service.";

export type Practice = {
  name: string; approval_mode: "auto" | "request"; cancellation_window_hours: number; late_cancel_fee_cents: number; crisis_text: string;
};

/** The practice settings row as seen by the current user (null for anonymous visitors). Cached per request. */
export const getPractice = cache(async (): Promise<Practice | null> => {
  const sb = await supabaseServer();
  const { data } = await sb.from("practices")
    .select("name, approval_mode, cancellation_window_hours, late_cancel_fee_cents, crisis_text").limit(1).maybeSingle();
  return (data as Practice | null) ?? null;
});

export async function getCrisisText(): Promise<string> {
  return (await getPractice())?.crisis_text?.trim() || DEFAULT_CRISIS_TEXT;
}
