import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { MAX_BODY_BYTES, parseAmountCents, processItn, type ItnDeps } from "@/lib/payments/itn";

// ---- an independent "PayFast": PHP urlencode over the UTF-8 bytes, MD5 over every field in order, empty ones included ----
const php = (s: string) => {
  let o = "";
  for (const b of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(b);
    o += /[A-Za-z0-9_.-]/.test(c) ? c : b === 0x20 ? "+" : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return o;
};
const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const sign = (pairs: [string, string][], pp: string | undefined, skipEmpty = false) =>
  md5(pairs.filter(([, v]) => !skipEmpty || v !== "").map(([k, v]) => `${k}=${php(v.trim())}`).join("&") + (pp ? `&passphrase=${php(pp)}` : ""));

const INV = "0b8e7e0a-2a77-4a52-8b1c-1d3d54cb0d11";
const PF_IP = "197.97.145.150";
const PP = "s3cret pass";
const base = (): [string, string][] => [
  ["m_payment_id", INV], ["pf_payment_id", "1089250"], ["payment_status", "COMPLETE"], ["item_name", "Invoice INV-00042"], ["item_description", ""],
  ["amount_gross", "950.00"], ["amount_fee", "-21.85"], ["amount_net", "928.15"], ["custom_str1", ""], ["name_first", "Zoë"], ["name_last", ""],
  ["email_address", "zoe@example.com"], ["merchant_id", "10000100"],
];
/** a body as PayFast would send it: given fields (overrides applied in place), signature last */
function body(over: Record<string, string> = {}, o: { pp?: string | undefined; skipEmpty?: boolean; extra?: [string, string][]; sig?: string } = {}) {
  const pp = "pp" in o ? o.pp : PP;
  let pairs = base().map(([k, v]) => [k, k in over ? over[k] : v] as [string, string]);
  pairs = pairs.concat(o.extra ?? []);
  const sig = o.sig ?? sign(pairs, pp, o.skipEmpty);
  return pairs.concat([["signature", sig]]).map(([k, v]) => `${k}=${php(v)}`).join("&");
}

type Calls = string[];
function mk(over: Partial<ItnDeps> & { outstanding?: number; invStatus?: string; invoice?: null; existing?: Awaited<ReturnType<ItnDeps["loadPaymentByRef"]>> } = {}) {
  const calls: Calls = [];
  const audits: { action: string; detail: Record<string, string> }[] = [];
  const deps: ItnDeps = {
    env: { merchantId: "10000100", passphrase: PP },
    async validate() { calls.push("validate"); return true; },
    async loadInvoice(id) { calls.push("loadInvoice"); return over.invoice === null ? null : { id, status: over.invStatus ?? "issued", outstandingCents: over.outstanding ?? 95000 }; },
    async loadPaymentByRef(ref) { calls.push("loadPaymentByRef:" + ref); return over.existing ?? null; },
    async recordPayment(a) { calls.push(`record:${a.invoiceId}:${a.amountCents}:${a.ref}`); return { ok: true }; },
    async audit(e) { audits.push(e); },
    ...over,
  };
  return { deps, calls, audits };
}
const run = (b: string, d = mk(), ip = PF_IP) => processItn(d.deps, { rawBody: b, sourceIp: ip }).then((r) => ({ r, ...d }));

describe("happy path", () => {
  it("records a genuine COMPLETE ITN exactly once with ref PF-<pf_payment_id>", async () => {
    const { r, calls, audits } = await run(body());
    expect(r).toEqual({ status: 200, body: "OK", outcome: "recorded" });
    expect(calls).toEqual(["loadInvoice", "loadPaymentByRef:PF-1089250", "validate", `record:${INV}:95000:PF-1089250`]);
    expect(audits).toEqual([]);
  });
  it("verifies the signature in received order including empty fields, and unicode values", async () => {
    expect((await run(body({ item_name: "Sessie – Zoë 日本 (nº 1) 'x' ~!*" }))).r.outcome).toBe("recorded");
  });
  it("also accepts the empty-skipping signature variant", async () => {
    expect((await run(body({}, { skipEmpty: true }))).r.outcome).toBe("recorded");
  });
  it("works with no passphrase configured", async () => {
    const d = mk({ env: { merchantId: "10000100" } });
    expect((await run(body({}, { pp: undefined }), d)).r.outcome).toBe("recorded");
  });
  it("signature hex is case-insensitive", async () => {
    const b = body();
    expect((await run(b.replace(/signature=([0-9a-f]+)$/, (_m, h: string) => "signature=" + h.toUpperCase()))).r.outcome).toBe("recorded");
  });
  it("source IP may be the IPv4-mapped form", async () => expect((await run(body(), mk(), "::ffff:197.97.145.150")).r.outcome).toBe("recorded"));
  it("an upper-case invoice id is normalised", async () => {
    const { calls } = await run(body({ m_payment_id: INV.toUpperCase() }));
    expect(calls).toContain(`record:${INV}:95000:PF-1089250`);
  });
});

describe("check order (R36)", () => {
  it("1 body: too large (> 10 KB) is rejected before anything else runs", async () => {
    const { r, calls, audits } = await run(body({ item_name: "x".repeat(MAX_BODY_BYTES) }));
    expect(r).toEqual({ status: 400, body: "rejected", outcome: "body_too_large" });
    expect(calls).toEqual([]);
    expect(audits).toEqual([{ action: "payfast.itn.rejected", detail: { reason: "body_too_large" } }]);
  });
  it("1 body: exactly 10 KB passes the size check", async () => {
    const b = "a=" + "x".repeat(MAX_BODY_BYTES - 2);
    expect(Buffer.byteLength(b)).toBe(MAX_BODY_BYTES);
    expect((await run(b)).r.outcome).toBe("bad_signature"); // past the size gate, stopped by the signature
  });
  it("1 body: multibyte size is measured in bytes", async () => {
    expect((await run("a=" + "é".repeat(MAX_BODY_BYTES / 2))).r.outcome).toBe("body_too_large");
  });
  it.each([["empty", ""], ["a duplicate key", "a=1&a=2&signature=" + "0".repeat(32)]])("1 body: %s -> bad_body", async (_n, b) => {
    const { r, calls } = await run(b);
    expect(r).toMatchObject({ status: 400, outcome: "bad_body" });
    expect(calls).toEqual([]);
  });
  it("1 body: a duplicate of amount_gross cannot hide behind a valid signature", async () => {
    expect((await run(body({}, { extra: [["amount_gross", "1.00"]] }))).r.outcome).toBe("bad_body");
  });
  it("2 signature: wrong, missing, malformed, tampered field", async () => {
    for (const b of [
      body({}, { sig: "0".repeat(32) }), body().replace(/&signature=.*$/, ""), body({}, { sig: "xyz" }), body({}, { sig: "" }),
      body({}, { sig: sign(base(), "other pass") }), body().replace("1089250", "1089251"), body().replace("950.00", "10.00"),
    ]) {
      const { r, calls } = await run(b);
      expect(r, b).toMatchObject({ status: 400, outcome: "bad_signature" });
      expect(calls).toEqual([]); // nothing was looked up or validated
    }
  });
  it("2 signature: a signature computed without the configured passphrase is refused", async () => {
    expect((await run(body({}, { pp: undefined }))).r.outcome).toBe("bad_signature");
  });
  it("2 signature: params in a different order than signed do not verify", async () => {
    const pairs = base();
    const sig = sign(pairs, PP);
    const swapped = [pairs[1], pairs[0], ...pairs.slice(2)].concat([["signature", sig]]).map(([k, v]) => `${k}=${php(v)}`).join("&");
    expect((await run(swapped)).r.outcome).toBe("bad_signature");
  });
  it("2 signature: a lone surrogate in the body is a clean 400, not a crash", async () => {
    expect((await run("a=%ED%A0%80&signature=" + "0".repeat(32))).r.status).toBe(400);
  });
  it("3 IP: outside the PayFast ranges, signature valid", async () => {
    for (const ip of ["1.2.3.4", "", "::1", "197.97.145.160", "undefined"]) {
      const { r, calls } = await run(body(), mk(), ip);
      expect(r, ip).toMatchObject({ status: 400, outcome: "bad_ip" });
      expect(calls).toEqual([]);
    }
  });
  it("signature is checked before the IP (a forged body from a bad IP reports bad_signature)", async () => {
    expect((await run(body({}, { sig: "0".repeat(32) }), mk(), "1.2.3.4")).r.outcome).toBe("bad_signature");
  });
  it("4 merchant: a different merchant_id is rejected, even correctly signed", async () => {
    const { r, calls } = await run(body({ merchant_id: "10000101" }));
    expect(r).toMatchObject({ status: 400, outcome: "bad_merchant" });
    expect(calls).toEqual([]);
  });
  it("4 merchant: missing merchant_id is rejected", async () => {
    const pairs = base().filter(([k]) => k !== "merchant_id");
    const b = pairs.concat([["signature", sign(pairs, PP)]]).map(([k, v]) => `${k}=${php(v)}`).join("&");
    expect((await run(b)).r.outcome).toBe("bad_merchant");
  });
  it("4 merchant: server without PAYFAST_MERCHANT_ID answers 500 (retry), not a silent accept", async () => {
    const { r, calls } = await run(body(), mk({ env: { passphrase: PP } }));
    expect(r).toMatchObject({ status: 500, outcome: "misconfigured" });
    expect(calls).toEqual([]);
  });
  it.each(["not-a-uuid", "", "0b8e7e0a-2a77-4a52-8b1c-1d3d54cb0d1", `${INV}x`, "' or 1=1 --", "../../etc"])("5 invoice id %j -> bad_invoice_id (no lookup)", async (id) => {
    const { r, calls } = await run(body({ m_payment_id: id }));
    expect(r).toMatchObject({ status: 400, outcome: "bad_invoice_id" });
    expect(calls).toEqual([]);
  });
  it("5 unknown invoice -> 400 and nothing else is called", async () => {
    const { r, calls, audits } = await run(body(), mk({ invoice: null }));
    expect(r).toMatchObject({ status: 400, outcome: "unknown_invoice" });
    expect(calls).toEqual(["loadInvoice"]);
    expect(audits[0].detail).toEqual({ reason: "unknown_invoice", invoice_id: INV });
  });
  it.each(["", "abc", "12 3", "-5", "1.5", "9".repeat(21)])("pf_payment_id %j is refused", async (pf) => {
    expect((await run(body({ pf_payment_id: pf }))).r.outcome).toBe("bad_pf_payment_id");
  });
});

describe("6 idempotent replay", () => {
  const existing = { invoiceId: INV, amountCents: 95000, method: "payfast" };
  it("same ref, same invoice, same amount -> 200 duplicate, and PayFast validate is NOT called, nothing recorded", async () => {
    const { r, calls, audits } = await run(body(), mk({ existing, outstanding: 0, invStatus: "paid" }));
    expect(r).toEqual({ status: 200, body: "OK", outcome: "duplicate" });
    expect(calls).not.toContain("validate");
    expect(calls.some((c) => c.startsWith("record:"))).toBe(false);
    expect(audits).toEqual([]);
  });
  it("replay wins over a non-COMPLETE status and over amount (the invoice is paid, outstanding is 0)", async () => {
    expect((await run(body(), mk({ existing, outstanding: 0 }))).r.outcome).toBe("duplicate");
  });
  it.each([
    ["another invoice", { ...existing, invoiceId: "11111111-1111-4111-8111-111111111111" }],
    ["another amount", { ...existing, amountCents: 95001 }],
    ["another method", { ...existing, method: "medical_aid" }],
  ])("same ref but %s -> 400 ref_conflict, no validate, nothing recorded", async (_n, ex) => {
    const { r, calls, audits } = await run(body(), mk({ existing: ex }));
    expect(r).toMatchObject({ status: 400, outcome: "ref_conflict" });
    expect(calls).not.toContain("validate");
    expect(calls.some((c) => c.startsWith("record:"))).toBe(false);
    expect(audits[0].detail).toMatchObject({ reason: "ref_conflict", invoice_id: INV });
  });
  it("an unparseable amount on a replayed ref is a conflict, not a duplicate", async () => {
    expect((await run(body({ amount_gross: "abc" }), mk({ existing }))).r.outcome).toBe("ref_conflict");
  });
});

describe("7 payment_status", () => {
  it.each(["FAILED", "CANCELLED", "PENDING", "complete", "", "SOMETHING"])("%j -> 200 ignored, audited, nothing recorded or validated", async (st) => {
    const { r, calls, audits } = await run(body({ payment_status: st }));
    expect(r).toEqual({ status: 200, body: "OK", outcome: "ignored" });
    expect(calls.some((c) => c.startsWith("record:") || c === "validate")).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0].detail.reason).toMatch(/^status_[a-z_]*$/);
    expect(audits[0].detail.invoice_id).toBe(INV);
  });
});

describe("8 amount must equal what is outstanding", () => {
  it.each(["949.99", "950.01", "950.000", "950.0", "950", "9.5e2", "abc", "", "-950.00", "+950.00", "0.00", "950,00", " 950.00", "0950.001", "1e3", "NaN", "9".repeat(30) + ".00"])(
    "amount_gross %j -> 400 amount_mismatch (validate never called)", async (a) => {
      const { r, calls } = await run(body({ amount_gross: a }));
      expect(r, a).toMatchObject({ status: 400, outcome: "amount_mismatch" });
      expect(calls).not.toContain("validate");
      expect(calls.some((c) => c.startsWith("record:"))).toBe(false);
    });
  it("a part-paid invoice must be paid for exactly what is left", async () => {
    expect((await run(body({ amount_gross: "600.00" }), mk({ outstanding: 60000 }))).r.outcome).toBe("recorded");
    expect((await run(body({ amount_gross: "950.00" }), mk({ outstanding: 60000 }))).r.outcome).toBe("amount_mismatch");
  });
  it("an already-paid invoice (outstanding 0) with a NEW ref is refused", async () => {
    expect((await run(body({ pf_payment_id: "999" }), mk({ outstanding: 0 }))).r.outcome).toBe("amount_mismatch");
    expect((await run(body({ pf_payment_id: "999", amount_gross: "0.00" }), mk({ outstanding: 0 }))).r.outcome).toBe("amount_mismatch");
  });
  it("amounts are parsed by string, free of float error", async () => {
    for (const [s, c] of [["0.29", 29], ["1.15", 115], ["4.35", 435], ["19999.99", 1999999], ["8.20", 820]] as const) expect(parseAmountCents(s)).toBe(c);
    expect((await run(body({ amount_gross: "4.35" }), mk({ outstanding: 435 }))).r.outcome).toBe("recorded");
  });
});

describe("9 PayFast server-side validate", () => {
  it("false -> 400 validation_failed, nothing recorded", async () => {
    const d = mk({ async validate() { return false; } });
    const { r, calls } = await run(body(), d);
    expect(r).toMatchObject({ status: 400, outcome: "validation_failed" });
    expect(calls.some((c) => c.startsWith("record:"))).toBe(false);
  });
  it("is given the raw body untouched", async () => {
    let seen = "";
    const b = body();
    await run(b, mk({ async validate(x) { seen = x; return true; } }));
    expect(seen).toBe(b);
  });
  it("a PayFast outage (throw) -> 500 so PayFast retries; nothing recorded", async () => {
    const { r, calls } = await run(body(), mk({ async validate() { throw new Error("timeout"); } }));
    expect(r).toMatchObject({ status: 500, outcome: "validate_unavailable" });
    expect(calls.some((c) => c.startsWith("record:"))).toBe(false);
  });
});

describe("10 recording and database errors", () => {
  const failing = (error: string) => mk({ async recordPayment() { return { ok: false, error }; } });
  it.each(["overpay", "invoice_not_payable"])("%s -> 200 duplicate-or-closed, audited for reconciliation", async (e) => {
    const { r, audits } = await run(body(), failing(e));
    expect(r).toEqual({ status: 200, body: "OK", outcome: "duplicate-or-closed" });
    expect(audits).toEqual([{ action: "payfast.itn.rejected", detail: { reason: e, invoice_id: INV, pf_payment_id: "1089250" } }]);
  });
  it("ref_conflict from the DB (race on another invoice) -> 400", async () => {
    expect((await run(body(), failing("ref_conflict"))).r).toMatchObject({ status: 400, outcome: "ref_conflict" });
  });
  it.each(["unknown_invoice", "forbidden", "invalid_amount", "ref_required", "connection reset", ""])("other DB error %j -> 500 (PayFast retries)", async (e) => {
    expect((await run(body(), failing(e))).r).toMatchObject({ status: 500, outcome: "record_failed" });
  });
  it("a thrown error from recordPayment -> 500", async () => {
    expect((await run(body(), mk({ async recordPayment() { throw new Error("socket"); } }))).r).toMatchObject({ status: 500 });
  });
  it("lookup failures -> 500", async () => {
    expect((await run(body(), mk({ async loadInvoice() { throw new Error("db"); } }))).r.status).toBe(500);
    expect((await run(body(), mk({ async loadPaymentByRef() { throw new Error("db"); } }))).r.status).toBe(500);
  });
});

describe("audit", () => {
  it("a failing audit write never changes the answer", async () => {
    const d = mk({ async audit() { throw new Error("audit down"); } });
    expect((await run(body({ amount_gross: "1.00" }), d)).r).toMatchObject({ status: 400, outcome: "amount_mismatch" });
  });
  it("audit entries carry reason codes (and the validated invoice id / gateway ref), never the raw body, card data or amounts", async () => {
    const { audits } = await run(body({ amount_gross: "1.00", name_first: "SECRETNAME" }));
    expect(JSON.stringify(audits)).not.toMatch(/SECRETNAME|zoe@example|signature|amount_gross|"1\.00|s3cret/);
    expect(audits[0].action).toBe("payfast.itn.rejected");
    expect(Object.keys(audits[0].detail).sort()).toEqual(["invoice_id", "pf_payment_id", "reason"]);
  });
  it("rejections before the signature is proven carry no attacker-supplied data at all", async () => {
    const { audits } = await run(body({ m_payment_id: "EVIL" }, { sig: "0".repeat(32) }));
    expect(audits).toEqual([{ action: "payfast.itn.rejected", detail: { reason: "bad_signature" } }]);
  });
  it("never writes the raw body to the console", async () => {
    const seen: string[] = [];
    const orig = [console.log, console.error, console.warn, console.info];
    console.log = console.error = console.warn = console.info = (...a: unknown[]) => { seen.push(a.join(" ")); };
    try { await run(body({ name_first: "SECRETNAME" }), mk({ async audit() { throw new Error("x"); }, async validate() { return false; } })); }
    finally { [console.log, console.error, console.warn, console.info] = orig; }
    expect(seen.join("\n")).not.toContain("SECRETNAME");
  });
});

describe("parseAmountCents", () => {
  it.each([["950.00", 95000], ["0.01", 1], ["0.00", 0], ["12345.60", 1234560]])("%s -> %i", (s, c) => expect(parseAmountCents(s)).toBe(c));
  it.each(["950", "950.0", "950.000", ".50", "-1.00", "1e2", "1,00", "", "abc", "1.0.0"])("%j -> null", (s) => expect(parseAmountCents(s)).toBeNull());
});
