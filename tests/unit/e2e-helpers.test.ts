import { describe, it, expect } from "vitest";
import { base32Decode, hotp, totp, secondsLeft } from "../e2e/helpers/totp";
import { itnBody, signItn } from "../e2e/helpers/itn";
import { payfastSignature } from "@/lib/payments/payfast";
import { e2eReady, missingE2E, ROLES, SEED } from "../e2e/helpers/roles";
import { classify, expectBlocked } from "../e2e/helpers/api";

// The e2e helpers cannot run here (no Supabase), but their pure parts can be checked: the TOTP code generator against the
// RFC 6238 test vectors, the PayFast signature copy against the app's own, and the role table against the seed.
const b32 = (s: string) => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "", out = "";
  for (const ch of Buffer.from(s)) bits += ch.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
};

describe("totp (RFC 6238 Appendix B vectors)", () => {
  const sha1 = b32("12345678901234567890"), sha256 = b32("12345678901234567890123456789012");
  const sha1Vectors: [number, string][] = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  it.each(sha1Vectors)("SHA-1 at T=%i gives %s (8 digits) and the last 6 digits as a 6 digit code", (t, code) => {
    expect(totp(sha1, t * 1000, { digits: 8 })).toBe(code);
    expect(totp(sha1, t * 1000)).toBe(code.slice(2));
  });
  it("SHA-256 at T=59 gives 46119246", () => expect(totp(sha256, 59_000, { digits: 8, algo: "sha256" })).toBe("46119246"));
  it("HOTP vectors from RFC 4226", () => {
    const key = Buffer.from("12345678901234567890");
    expect([0, 1, 2, 3, 9].map((c) => hotp(key, c))).toEqual(["755224", "287082", "359152", "969429", "520489"]);
  });
  it("base32 decoding ignores case, spaces and padding; rejects other characters", () => {
    expect(base32Decode("gezd gnbv GY3TQOJQ====").toString()).toBe("1234567890");
    expect(() => base32Decode("0189")).toThrow(/base32/);
  });
  it("secondsLeft counts down inside the 30 s window", () => {
    expect(secondsLeft(0)).toBe(30);
    expect(secondsLeft(29_999)).toBe(1);
    expect(secondsLeft(30_000)).toBe(30);
  });
});

describe("ITN helper", () => {
  it("signs exactly like the app's payfastSignature (every field, empty ones included, with the passphrase)", () => {
    const fields: [string, string][] = [["m_payment_id", "abc"], ["pf_payment_id", "123"], ["item_name", "Invoice (INV-1) & more!"], ["empty", ""], ["amount_gross", "950.00"]];
    expect(signItn(fields, "pass phrase")).toBe(payfastSignature(fields, "pass phrase", { includeEmpty: true }));
    expect(signItn(fields, "")).toBe(payfastSignature(fields, "", { includeEmpty: true }));
  });
  it("builds a body whose signature field verifies", () => {
    const body = itnBody({ invoiceId: "00000000-0000-4000-8000-000000000001", amountCents: 95000, merchantId: "10000100", passphrase: "x" });
    const pairs = body.split("&").map((p) => p.split("=").map((s) => decodeURIComponent(s.replace(/\+/g, " "))) as [string, string]);
    const sig = pairs.find(([k]) => k === "signature")![1];
    expect(pairs.find(([k]) => k === "amount_gross")![1]).toBe("950.00");
    expect(sig).toBe(payfastSignature(pairs, "x", { includeEmpty: true }));
  });
});

describe("e2e role table", () => {
  it("lists the seeded demo accounts and their storage files", () => {
    expect(Object.values(ROLES).map((r) => r.email).sort()).toEqual(["admin@demo.test", "bookkeeper@demo.test", "guardian@demo.test", "patient.a@demo.test", "patient.b@demo.test", "patient.c@demo.test", "psychologist@demo.test"]);
    expect(Object.values(ROLES).filter((r) => r.staff)).toHaveLength(3);
    expect(ROLES.psychologist.state).toMatch(/tests[\\/]e2e[\\/]\.auth[\\/]psychologist\.json$/);
    expect(SEED.patient.a).toMatch(/^b0000000-/);
  });
  it("reports which variables are missing", () => {
    const saved = { ...process.env };
    try {
      delete process.env.E2E_SUPABASE_URL; delete process.env.E2E_SUPABASE_ANON_KEY; delete process.env.E2E_SUPABASE_SERVICE_KEY;
      expect(e2eReady()).toBe(false);
      expect(missingE2E()).toEqual(["E2E_SUPABASE_URL", "E2E_SUPABASE_ANON_KEY", "E2E_SUPABASE_SERVICE_KEY"]);
      process.env.E2E_SUPABASE_URL = "http://x"; process.env.E2E_SUPABASE_ANON_KEY = "a"; process.env.E2E_SUPABASE_SERVICE_KEY = "s";
      expect(e2eReady()).toBe(true);
    } finally { process.env = saved; }
  });
});

describe("direct-API result classification (the isolation checks must not mistake an error for 'no rows')", () => {
  it("an empty result and a permission error are blocked; rows and every other error are not", () => {
    expect(classify({ data: [], error: null })).toEqual({ kind: "rows", n: 0 });
    expect(() => expectBlocked({ data: [], error: null }, "empty")).not.toThrow();
    expect(() => expectBlocked({ data: null, error: { code: "42501", message: "permission denied for table claims" } }, "denied")).not.toThrow();
    expect(() => expectBlocked({ data: null, error: { message: "permission denied for function audit_append" } }, "denied by text")).not.toThrow();
    expect(() => expectBlocked({ data: [{ id: 1 }], error: null }, "a visible row")).toThrow(/1 row/);
    for (const [code, message] of [["42P01", "relation \"patientz\" does not exist"], ["PGRST205", "Could not find the table 'public.patientz'"], ["42703", "column patients.idd does not exist"], ["PGRST100", "failed to parse"], ["", "fetch failed"]])
      expect(() => expectBlocked({ data: null, error: { code, message } }, "typo"), message).toThrow(/error:/);
  });
});
