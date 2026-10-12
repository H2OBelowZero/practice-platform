import "server-only";
import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/server";

export type BillingPractice = {
  name: string; registration_no: string | null; hpcsa_no: string | null; vat_registered: boolean; vat_rate: number; late_cancel_fee_cents: number;
};

/** Practice details the billing screens need (VAT settings, receipt header, late fee). Cached per request. Read with the signed-in user's own client. */
export const getBillingPractice = cache(async (): Promise<BillingPractice | null> => {
  const sb = await supabaseServer();
  const { data } = await sb.from("practices").select("name, registration_no, hpcsa_no, vat_registered, vat_rate, late_cancel_fee_cents").limit(1).maybeSingle();
  if (!data) return null;
  return { ...(data as BillingPractice), vat_rate: Number(data.vat_rate), late_cancel_fee_cents: Number(data.late_cancel_fee_cents) }; // numeric(5,2) may arrive as a string
});
