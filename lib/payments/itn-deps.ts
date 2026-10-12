import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOutstanding } from "@/lib/billing/outstanding";
import { payfastValidate } from "@/lib/payments/payfast";
import type { ItnDeps } from "@/lib/payments/itn";

/**
 * Real dependencies of processItn. `service` MUST be the service-role client: reads bypass RLS (no user session exists on a
 * webhook) and record_payment's service path needs the service_role JWT (0005, R24). Kept separate from the route so the
 * exact DB calls can be unit-tested (R34 call-site audit).
 */
export function makeItnDeps(service: SupabaseClient, env: ItnDeps["env"], validate: ItnDeps["validate"] = payfastValidate): ItnDeps {
  return {
    validate, env,
    async loadInvoice(id) {
      const b = await loadOutstanding(service, id);
      return b && { id: b.invoiceId, status: b.status, outstandingCents: b.outstandingCents };
    },
    async loadPaymentByRef(ref) {
      const { data, error } = await service.from("payments").select("invoice_id,amount_cents,method").eq("gateway_ref", ref).maybeSingle();
      if (error) throw new Error(`payments lookup: ${error.code ?? ""} ${error.message}`);
      return data && { invoiceId: String(data.invoice_id), amountCents: Number(data.amount_cents), method: String(data.method) };
    },
    async recordPayment({ invoiceId, amountCents, ref }) {
      const { error } = await service.rpc("record_payment", { p_invoice: invoiceId, p_method: "payfast", p_amount: amountCents, p_ref: ref, p_by: null });
      return error ? { ok: false, error: error.message } : { ok: true };
    },
    async audit({ action, detail }) {
      const { error } = await service.rpc("audit_append", { p_actor: null, p_role: "system", p_action: action, p_entity: "payments", p_entity_id: null, p_detail: detail });
      if (error) throw new Error(`audit_append failed: ${error.code ?? ""} ${error.message}`);
    },
  };
}
