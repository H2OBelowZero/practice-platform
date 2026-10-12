import "server-only";
import { createHash } from "crypto";
import { appUrl } from "@/lib/app-url";

/**
 * PHP `urlencode` semantics (R10): PayFast signs with them. Spaces become "+", and every byte except A-Z a-z 0-9 - _ . is
 * percent-encoded with UPPERCASE hex. encodeURIComponent leaves ! ' ( ) * ~ alone, so those are encoded here as well.
 */
const enc = (v: string) =>
  encodeURIComponent(v).replace(/%20/g, "+").replace(/[!'()*~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

type Entries = ReadonlyArray<readonly [string, string]>;
type Params = Record<string, string> | Entries;
const entriesOf = (p: Params): Entries => (Array.isArray(p) ? (p as Entries) : Object.entries(p as Record<string, string>));

/**
 * PayFast MD5 signature over `params` IN THE GIVEN ORDER (PayFast requires its documented order, see CHECKOUT_FIELD_ORDER).
 * Values are trimmed; the `signature` key is skipped; the passphrase is appended as `&passphrase=<enc>` when set.
 * Checkout signing omits empty values (default). The ITN is signed over every posted field INCLUDING empty ones:
 * pass `{ includeEmpty: true }` when verifying one. Pass an array of [key, value] pairs to keep the exact order even for
 * integer-like keys (a plain object would reorder those).
 */
export function payfastSignature(params: Params, passphrase?: string, opts: { includeEmpty?: boolean } = {}): string {
  let s = entriesOf(params)
    .filter(([k, v]) => k !== "signature" && (opts.includeEmpty || v.trim() !== ""))
    .map(([k, v]) => `${k}=${enc(v.trim())}`).join("&");
  const pp = passphrase?.trim();
  if (pp) s += `${s ? "&" : ""}passphrase=${enc(pp)}`;
  return createHash("md5").update(s).digest("hex");
}

/**
 * Field order PayFast requires for the checkout signature (only fields we send are used, in this relative order).
 * https://developers.payfast.co.za/docs#step_2_signature  (re-check the field list there before go-live)
 */
export const CHECKOUT_FIELD_ORDER = [
  "merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url", "name_first", "name_last", "email_address",
  "cell_number", "m_payment_id", "amount", "item_name", "item_description",
] as const;

const host = () => (process.env.PAYFAST_SANDBOX === "true" ? "sandbox.payfast.co.za" : "www.payfast.co.za");

const required = (name: string) => {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} must be set to build a PayFast checkout`);
  return v;
};
const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Integer cents -> "950.00" without float arithmetic. */
export const centsToDecimal = (cents: number) => {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("invalid_amount");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
};

/** The form the portal posts to PayFast. Whole outstanding balance only (the ITN requires amount == outstanding). */
export function buildCheckout(o: { invoiceId: string; number: string; amountCents: number; name: string; email: string }): { action: string; fields: Record<string, string> } {
  const base = appUrl();
  const passphrase = process.env.PAYFAST_PASSPHRASE?.trim();
  if (!passphrase && process.env.PAYFAST_SANDBOX !== "true") {
    throw new Error("PAYFAST_PASSPHRASE must be set (it must equal the passphrase in the PayFast dashboard); only the sandbox may run without one");
  }
  const raw: Record<(typeof CHECKOUT_FIELD_ORDER)[number], string> = {
    merchant_id: required("PAYFAST_MERCHANT_ID"), merchant_key: required("PAYFAST_MERCHANT_KEY"),
    // return_url only shows the stored status: the page never trusts the query string, only the ITN records money
    return_url: `${base}/portal/payments?paid=${encodeURIComponent(o.invoiceId)}`, cancel_url: `${base}/portal/payments`,
    notify_url: `${base}/api/payfast/itn`,
    name_first: clean(o.name, 100), name_last: "", email_address: clean(o.email, 255), cell_number: "",
    m_payment_id: o.invoiceId, amount: centsToDecimal(o.amountCents),
    item_name: clean(`Invoice ${o.number}`, 100), item_description: "",
  };
  const fields: Record<string, string> = {};
  for (const k of CHECKOUT_FIELD_ORDER) if (raw[k] !== "") fields[k] = raw[k]; // empty values are neither posted nor signed
  fields.signature = payfastSignature(fields, passphrase);
  return { action: `https://${host()}/eng/process`, fields };
}

// PayFast source IPv4 ranges (CIDR). Verify against PayFast's current documentation before go-live; the list is exported
// for the go-live checklist. https://developers.payfast.co.za/docs#step_4_confirm_payment
export const PAYFAST_IP_RANGES = [
  "197.97.145.144/28", "41.74.179.192/27", "102.216.36.0/28", "102.216.36.128/28", "144.126.193.139/32",
] as const;

/** "a.b.c.d" -> uint32, or null. Strict: four decimal octets 0-255, no leading zeros (no octal ambiguity), nothing else. */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    if (m[i].length > 1 && m[i].startsWith("0")) return null;
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}
const RANGES = PAYFAST_IP_RANGES.map((c) => {
  const [base, bits] = c.split("/");
  const size = 2 ** (32 - Number(bits));
  const start = ipv4ToInt(base)!;
  return { start, end: start + size - 1 };
});

/** True when `ip` is an IPv4 address in a PayFast range (`::ffff:a.b.c.d` mapped form accepted; other IPv6 is not). */
export function isPayfastIp(ip: string): boolean {
  const n = ipv4ToInt((ip ?? "").trim().replace(/^::ffff:/i, ""));
  return n !== null && RANGES.some((r) => n >= r.start && n <= r.end);
}

/**
 * Server-side confirmation: post the ITN back to PayFast (without the signature field, as in PayFast's sample) and
 * accept only the exact body "VALID". Non-VALID answers return false; a network error, timeout (8 s) or HTTP 5xx throws,
 * so the caller can answer 500 and let PayFast retry instead of rejecting a genuine payment.
 */
export async function payfastValidate(rawBody: string): Promise<boolean> {
  const body = rawBody.split("&").filter((p) => p.split("=", 1)[0] !== "signature").join("&");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`https://${host()}/eng/query/validate`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: ctl.signal, cache: "no-store",
    });
    if (res.status >= 500) throw new Error(`payfast validate http ${res.status}`);
    return (await res.text()).trim() === "VALID";
  } finally { clearTimeout(timer); }
}
