import { createHash } from "node:crypto";
import { svc, must } from "./db";

// The PayFast notification (ITN) cannot be replayed end to end against a deployment: the real route checks the caller's address against
// PayFast's ranges, taken from x-vercel-forwarded-for, which a test cannot set on Vercel. Production code is NOT weakened for tests.
// So the ITN step of the workflows is done at the database level, with the SAME call the route makes after all its checks passed
// (lib/payments/itn-deps.ts: record_payment as the service role, method 'payfast', ref PF-<pf_payment_id>, p_by null).
// What the route's checks do is covered by tests/unit/itn*.test.ts and tests/db/itn-record.test.ts; the one thing worth proving on a
// deployment is that a correctly signed notification from a non-PayFast address is refused (see `postSignedItnFromHere`).

let seq = 0;
export const newPfPaymentId = () => String(Date.now()).slice(-9) + String(++seq).padStart(2, "0");

/** What the ITN route does once PayFast's notification is accepted. Idempotent for the same ref, invoice and amount. */
export async function recordPayfastPayment(invoiceId: string, amountCents: number, pfPaymentId = newPfPaymentId()): Promise<{ ref: string }> {
  const ref = `PF-${pfPaymentId}`;
  must(await svc().rpc("record_payment", { p_invoice: invoiceId, p_method: "payfast", p_amount: amountCents, p_ref: ref, p_by: null }), "record_payment (payfast)");
  return { ref };
}

/** What the route does for a validated payment that no longer fits its invoice: one staff task, no payment row. Returns the task source. */
export async function raiseUnreconciled(invoiceId: string, amountCents: number, outstandingCents: number, reason: "amount_mismatch" | "invoice_not_payable" | "overpay", pfPaymentId = newPfPaymentId()) {
  must(await svc().rpc("raise_payfast_unreconciled", { p_invoice: invoiceId, p_pf_payment_id: pfPaymentId, p_amount_cents: amountCents, p_outstanding_cents: outstandingCents, p_reason: reason }), "raise_payfast_unreconciled");
  return `payfast_unreconciled:${pfPaymentId}`;
}

// ---- a signed body, for the negative check -----------------------------------------------------------------------------------------------
// Same rules as lib/payments/payfast.ts payfastSignature (PHP urlencode, every field incl. empty ones, passphrase appended). Duplicated on
// purpose: that module imports "server-only". tests/unit/e2e-helpers.test.ts proves the two produce the same signature.
const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+").replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
export function signItn(fields: [string, string][], passphrase: string): string {
  let s = fields.filter(([k]) => k !== "signature").map(([k, v]) => `${k}=${enc(v.trim())}`).join("&");
  if (passphrase.trim()) s += `&passphrase=${enc(passphrase.trim())}`;
  return createHash("md5").update(s).digest("hex");
}
export function itnBody(o: { invoiceId: string; amountCents: number; merchantId: string; passphrase: string; pfPaymentId?: string }): string {
  const amount = `${Math.floor(o.amountCents / 100)}.${String(o.amountCents % 100).padStart(2, "0")}`;
  const fields: [string, string][] = [
    ["m_payment_id", o.invoiceId], ["pf_payment_id", o.pfPaymentId ?? newPfPaymentId()], ["payment_status", "COMPLETE"], ["item_name", "E2E"],
    ["amount_gross", amount], ["amount_fee", "0.00"], ["amount_net", amount], ["merchant_id", o.merchantId],
  ];
  return [...fields, ["signature", signItn(fields, o.passphrase)] as [string, string]].map(([k, v]) => `${k}=${enc(v)}`).join("&");
}
/** POST a correctly signed notification from THIS machine (not a PayFast address). The route must refuse it. Returns the HTTP status. */
export async function postSignedItnFromHere(baseUrl: string, body: string): Promise<number> {
  const res = await fetch(new URL("/api/payfast/itn", baseUrl), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  return res.status;
}
