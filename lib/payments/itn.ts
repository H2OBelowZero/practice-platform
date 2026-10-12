import { timingSafeEqual } from "crypto";
import { isPayfastIp, payfastSignature } from "@/lib/payments/payfast";

/**
 * PayFast ITN (instant transaction notification) core. Pure of Next.js and Supabase: everything external is injected so the
 * check order (R36) is unit-tested. The route (app/api/payfast/itn/route.ts) wires real dependencies.
 *
 * Order of checks, cheapest and most decisive first, money recorded last:
 *   1 body parses (<= 10 KB, no duplicate keys)   [production without a passphrase: 500 misconfigured]   2 signature
 *   3 source IP in a PayFast range   4 merchant_id   5 m_payment_id is a UUID and the invoice exists
 *   6 idempotent replay of PF-<pf_payment_id> (recorded payment, or an already raised reconciliation task)
 *   7 payment_status (only COMPLETE moves money)   8 amount_gross == outstanding and invoice payable
 *   9 PayFast server-side validate   10 record_payment (service RPC)
 * A COMPLETE payment that no longer fits the invoice (step 8 fails, or step 10 says overpay / invoice_not_payable) is real money:
 * after PayFast's validate says VALID it is NOT refused but raised as an "unreconciled" staff task + audit row, and answered 200.
 * Audit rows are written only once the signature has been verified: before that the caller is anonymous and could flood the log
 * (those rejections log a fixed reason code to the console). PayFast retries anything that is not HTTP 200, so:
 * 400 = rejected for good, 500 = temporary, try again.
 */

export const MAX_BODY_BYTES = 10 * 1024;
const MAX_INT = 2_147_483_647; // payments.amount_cents is int

export type ItnInvoice = { id: string; status: string; outstandingCents: number };
export type ItnPayment = { invoiceId: string; amountCents: number; method: string };
export type UnreconciledReason = "amount_mismatch" | "invoice_not_payable" | "overpay";
export type ItnDeps = {
  validate(rawBody: string): Promise<boolean>;
  loadInvoice(invoiceId: string): Promise<ItnInvoice | null>;
  loadPaymentByRef(ref: string): Promise<ItnPayment | null>;
  /** true when a reconciliation task for this pf_payment_id already exists */
  unreconciledExists(pfPaymentId: string): Promise<boolean>;
  /** error is the DB exception text (e.g. "overpay"); a thrown error is treated as a temporary failure */
  recordPayment(a: { invoiceId: string; amountCents: number; ref: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** one staff task per pf_payment_id (idempotent); throws on failure */
  raiseUnreconciled(a: { invoiceId: string; pfPaymentId: string; amountCents: number; outstandingCents: number; reason: UnreconciledReason }): Promise<void>;
  audit(e: { action: string; detail: Record<string, string | number> }): Promise<void>;
  /** sandbox: PAYFAST_SANDBOX === "true" (the only mode allowed to run without a passphrase) */
  env: { merchantId?: string; passphrase?: string; sandbox?: boolean };
};
export type ItnResult = { status: 200 | 400 | 500; body: string; outcome: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "950.00" -> 95000 by string. Exactly two decimals; anything else (950, 950.000, 9.5e2, -1, abc) is null. */
export function parseAmountCents(s: string): number | null {
  const m = /^(\d{1,10})\.(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

const hexEq = (a: string, b: string) => {
  const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function processItn(deps: ItnDeps, input: { rawBody: string; sourceIp: string }): Promise<ItnResult> {
  // Audit failures never change the answer (fail-open here: the HTTP result is what PayFast acts on). Reason codes only.
  const note = async (action: string, detail: Record<string, string | number>) => {
    try { await deps.audit({ action, detail }); } catch { console.error("payfast itn: audit failed"); }
  };
  let authentic = false; // set once the signature has been verified
  let ctx: Record<string, string> = {};
  const reject = async (reason: string, status: 400 | 500 = 400): Promise<ItnResult> => {
    if (authentic) await note("payfast.itn.rejected", { reason, ...ctx });
    else console.error(`payfast itn rejected: ${reason}`); // anonymous caller: no audit row (log flooding), fixed code only
    return { status, body: status === 400 ? "rejected" : "error", outcome: reason };
  };

  // 1 parse
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_BODY_BYTES) return reject("body_too_large");
  const pairs: [string, string][] = [...new URLSearchParams(input.rawBody)];
  const p: Record<string, string> = Object.create(null);
  for (const [k, v] of pairs) {
    if (Object.hasOwn(p, k)) return reject("bad_body"); // duplicate key: ambiguous which value was signed
    p[k] = v;
  }
  if (pairs.length === 0) return reject("bad_body");

  // Without a passphrase the signature is an unkeyed MD5 anyone can compute: refuse outside the sandbox.
  if (!deps.env.passphrase && !deps.env.sandbox) {
    console.error("payfast: passphrase missing");
    return { status: 500, body: "error", outcome: "misconfigured" };
  }

  // 2 signature (checked in constant time; PayFast signs every posted field in received order, empty ones included.
  //   The variant that skips empty values is accepted as well so a doc mismatch cannot silently block real payments:
  //   both are keyed with the secret passphrase, so this opens no forgery path.)
  const got = (p.signature ?? "").toLowerCase();
  let signed = false;
  try {
    const a = payfastSignature(pairs, deps.env.passphrase, { includeEmpty: true });
    const b = payfastSignature(pairs, deps.env.passphrase);
    signed = /^[0-9a-f]{32}$/.test(got) && [hexEq(got, a), hexEq(got, b)].some(Boolean);
  } catch { signed = false; } // lone surrogate etc.: cannot be a genuine ITN
  if (!signed) return reject("bad_signature");
  authentic = true;

  // 3 source IP
  if (!isPayfastIp(input.sourceIp)) return reject("bad_ip");

  // 4 merchant
  if (!deps.env.merchantId) return reject("misconfigured", 500);
  if (p.merchant_id !== deps.env.merchantId) return reject("bad_merchant");

  // 5 invoice
  const invoiceId = (p.m_payment_id ?? "").toLowerCase();
  if (!UUID.test(invoiceId)) return reject("bad_invoice_id");
  ctx = { invoice_id: invoiceId };
  let inv: ItnInvoice | null;
  try { inv = await deps.loadInvoice(invoiceId); } catch { return reject("lookup_failed", 500); }
  if (!inv) return reject("unknown_invoice");
  const pf = p.pf_payment_id ?? "";
  if (!/^\d{1,20}$/.test(pf)) return reject("bad_pf_payment_id");
  ctx = { invoice_id: invoiceId, pf_payment_id: pf };
  const ref = `PF-${pf}`;
  const cents = parseAmountCents(p.amount_gross ?? "");

  // 6 replay: PayFast resends until it sees 200, so a recorded ref for this invoice and amount is a success, with no PayFast call.
  //   Likewise a payment already raised for reconciliation (the task is the record; no second audit row).
  let existing: ItnPayment | null, raised = false;
  try {
    existing = await deps.loadPaymentByRef(ref);
    if (!existing) raised = await deps.unreconciledExists(pf);
  } catch { return reject("lookup_failed", 500); }
  if (existing) {
    if (existing.invoiceId === invoiceId && existing.amountCents === cents && existing.method === "payfast") {
      return { status: 200, body: "OK", outcome: "duplicate" };
    }
    return reject("ref_conflict");
  }
  if (raised) return { status: 200, body: "OK", outcome: "duplicate-unreconciled" };

  // 7 status: only COMPLETE records money
  if (p.payment_status !== "COMPLETE") {
    await note("payfast.itn.ignored", { reason: "status_" + String(p.payment_status ?? "missing").toLowerCase().replace(/[^a-z_]/g, "").slice(0, 20), ...ctx });
    return { status: 200, body: "OK", outcome: "ignored" };
  }

  // an amount we cannot read or store is not a payment we can reconcile either
  if (cents === null || cents <= 0 || cents > MAX_INT) return reject("amount_mismatch");

  // Genuine money the invoice no longer accepts: keep it visible instead of losing it (task for staff + audit), answer 200 so PayFast stops.
  const unreconciled = async (reason: UnreconciledReason): Promise<ItnResult> => {
    try { await deps.raiseUnreconciled({ invoiceId, pfPaymentId: pf, amountCents: cents, outstandingCents: inv.outstandingCents, reason }); }
    catch { return reject("record_failed", 500); }
    await note("payfast.itn.unreconciled", { reason, invoice_id: invoiceId, pf_payment_id: pf, amount_cents: cents, outstanding_cents: inv.outstandingCents });
    return { status: 200, body: "OK", outcome: "unreconciled" };
  };

  // 8 the invoice must still take this payment and the amount must be exactly what is outstanding (checkout bills the whole balance)
  const mismatch: UnreconciledReason | null = !["issued", "part_paid"].includes(inv.status) ? "invoice_not_payable" : cents !== inv.outstandingCents ? "amount_mismatch" : null;

  // 9 PayFast confirms it sent this (also before a mismatch is treated as real money)
  let valid: boolean;
  try { valid = await deps.validate(input.rawBody); } catch { return reject("validate_unavailable", 500); }
  if (!valid) return reject("validation_failed");
  if (mismatch) return unreconciled(mismatch);

  // 10 record. record_payment locks the invoice and guards overpay / closed invoices / ref reuse.
  let res: Awaited<ReturnType<ItnDeps["recordPayment"]>>;
  try { res = await deps.recordPayment({ invoiceId, amountCents: cents, ref }); } catch { return reject("record_failed", 500); }
  if (res.ok) return { status: 200, body: "OK", outcome: "recorded" };
  if (/ref_conflict/.test(res.error)) return reject("ref_conflict");
  // the invoice changed between our read and the insert (paid, voided, credited): same treatment
  if (/overpay/.test(res.error)) return unreconciled("overpay");
  if (/invoice_not_payable/.test(res.error)) return unreconciled("invoice_not_payable");
  return reject("record_failed", 500);
}
