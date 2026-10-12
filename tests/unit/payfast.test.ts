import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import {
  buildCheckout, CHECKOUT_FIELD_ORDER, centsToDecimal, isPayfastIp, PAYFAST_IP_RANGES, payfastSignature, payfastValidate,
} from "@/lib/payments/payfast";

/** Independent reference for PHP urlencode(): works on the UTF-8 bytes, nothing shared with the implementation. */
export function phpUrlencode(s: string): string {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.-]/.test(c)) out += c;
    else if (b === 0x20) out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("payfastSignature (PHP urlencode semantics, R10)", () => {
  it("signs params in order with url-encoded values and passphrase", () => {
    expect(payfastSignature({ m_payment_id: "INV-1", amount: "950.00" }, "pass word"))
      .toBe(md5("m_payment_id=INV-1&amount=950.00&passphrase=pass+word"));
  });
  it("hand-written vectors for the characters encodeURIComponent leaves alone", () => {
    // PHP: urlencode("it's (a) ~test! *") === "it%27s+%28a%29+%7Etest%21+%2A"
    expect(payfastSignature({ item_name: "it's (a) ~test! *" })).toBe(md5("item_name=it%27s+%28a%29+%7Etest%21+%2A"));
    // PHP: urlencode("Zoë & Co/é@x.za") === "Zo%C3%AB+%26+Co%2F%C3%A9%40x.za"
    expect(payfastSignature({ name_first: "Zoë & Co/é@x.za" })).toBe(md5("name_first=Zo%C3%AB+%26+Co%2F%C3%A9%40x.za"));
    // unreserved for PHP: letters, digits, - _ .
    expect(payfastSignature({ a: "A-z_9.0" })).toBe(md5("a=A-z_9.0"));
  });
  it("matches the reference encoder over every printable ASCII character and some unicode", () => {
    const all = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
    for (const v of [all, "日本語 テスト", "emoji 😀 ok", "tab\tnew\nline", "100% sure", "a+b=c&d"]) {
      // not trimmed away: wrap in a letter so trim() cannot change the expected string
      const val = `x${v}x`;
      expect(payfastSignature({ k: val })).toBe(md5(`k=${phpUrlencode(val)}`));
    }
  });
  it("uses uppercase hex", () => expect(payfastSignature({ k: "é/" })).toBe(md5("k=%C3%A9%2F")));
  it("trims values", () => expect(payfastSignature({ a: "  x y  " })).toBe(md5("a=x+y")));
  it("skips the signature key and, by default, empty values", () => {
    expect(payfastSignature({ a: "1", b: "", c: "   ", signature: "zzz", d: "2" })).toBe(md5("a=1&d=2"));
  });
  it("includeEmpty keeps empty values (the ITN signs them)", () => {
    expect(payfastSignature({ a: "1", b: "", signature: "zzz", d: "2" }, "pp", { includeEmpty: true })).toBe(md5("a=1&b=&d=2&passphrase=pp"));
  });
  it("order matters", () => {
    expect(payfastSignature({ a: "1", b: "2" })).not.toBe(payfastSignature({ b: "2", a: "1" }));
    expect(payfastSignature({ a: "1", b: "2" })).toBe(md5("a=1&b=2"));
  });
  it("accepts ordered pairs, keeping integer-like keys in place (a plain object would reorder them)", () => {
    expect(payfastSignature([["b", "1"], ["10", "x"], ["a", "2"]])).toBe(md5("b=1&10=x&a=2"));
  });
  it("no passphrase / blank passphrase appends nothing; passphrase is encoded and trimmed", () => {
    expect(payfastSignature({ a: "1" })).toBe(md5("a=1"));
    expect(payfastSignature({ a: "1" }, "")).toBe(md5("a=1"));
    expect(payfastSignature({ a: "1" }, " p&q ")).toBe(md5("a=1&passphrase=p%26q"));
  });
  it("only a passphrase", () => expect(payfastSignature({}, "pp")).toBe(md5("passphrase=pp")));
});

describe("centsToDecimal", () => {
  it.each([[95000, "950.00"], [5, "0.05"], [100, "1.00"], [123456789, "1234567.89"], [1, "0.01"]])("%i -> %s", (c, s) => expect(centsToDecimal(c)).toBe(s));
  it.each([0, -1, 1.5, NaN, Infinity])("rejects %s", (c) => expect(() => centsToDecimal(c)).toThrow("invalid_amount"));
});

describe("buildCheckout", () => {
  const env = () => {
    vi.stubEnv("PAYFAST_MERCHANT_ID", "10000100"); vi.stubEnv("PAYFAST_MERCHANT_KEY", "46f0cd694581a"); vi.stubEnv("PAYFAST_PASSPHRASE", "jt7NOE43FZPn");
    vi.stubEnv("APP_URL", "https://practice.example.co.za/"); vi.stubEnv("PAYFAST_SANDBOX", "true");
  };
  const o = { invoiceId: "0b8e7e0a-2a77-4a52-8b1c-1d3d54cb0d11", number: "INV-00042", amountCents: 95000, name: "Zoë O'Neil", email: "zoe@example.com" };

  it("builds the sandbox form with the documented URLs and fields", () => {
    env();
    const { action, fields } = buildCheckout(o);
    expect(action).toBe("https://sandbox.payfast.co.za/eng/process");
    expect(fields).toMatchObject({
      merchant_id: "10000100", merchant_key: "46f0cd694581a",
      return_url: `https://practice.example.co.za/portal/payments?paid=${o.invoiceId}`,
      cancel_url: "https://practice.example.co.za/portal/payments", notify_url: "https://practice.example.co.za/api/payfast/itn",
      name_first: "Zoë O'Neil", email_address: "zoe@example.com", m_payment_id: o.invoiceId, amount: "950.00", item_name: "Invoice INV-00042",
    });
  });
  it("uses the live host unless PAYFAST_SANDBOX is exactly 'true'", () => {
    env(); vi.stubEnv("PAYFAST_SANDBOX", "false");
    expect(buildCheckout(o).action).toBe("https://www.payfast.co.za/eng/process");
    vi.stubEnv("PAYFAST_SANDBOX", "");
    expect(buildCheckout(o).action).toBe("https://www.payfast.co.za/eng/process");
  });
  it("field order is PayFast's documented order, signature last", () => {
    env();
    const keys = Object.keys(buildCheckout(o).fields);
    expect(keys).toEqual(["merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url", "name_first", "email_address", "m_payment_id", "amount", "item_name", "signature"]);
    const idx = keys.filter((k) => k !== "signature").map((k) => (CHECKOUT_FIELD_ORDER as readonly string[]).indexOf(k));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx); // ascending in the documented list
  });
  it("signature is the PHP-urlencode MD5 of the fields in that order plus the passphrase", () => {
    env();
    const { fields } = buildCheckout(o);
    const { signature, ...rest } = fields;
    const str = Object.entries(rest).map(([k, v]) => `${k}=${phpUrlencode(v.trim())}`).join("&") + "&passphrase=" + phpUrlencode("jt7NOE43FZPn");
    expect(signature).toBe(md5(str));
    expect(str).toContain("name_first=Zo%C3%AB+O%27Neil"); // apostrophe is encoded, as PHP does
  });
  it("works without a passphrase", () => {
    env(); vi.stubEnv("PAYFAST_PASSPHRASE", "");
    const { signature, ...rest } = buildCheckout(o).fields;
    expect(signature).toBe(md5(Object.entries(rest).map(([k, v]) => `${k}=${phpUrlencode(v)}`).join("&")));
  });
  it("sanitises and truncates item_name (<= 100 chars, no control characters)", () => {
    env();
    const f = buildCheckout({ ...o, number: "INV-1\n\t" + "x".repeat(200) }).fields;
    expect(f.item_name.length).toBeLessThanOrEqual(100);
    expect(f.item_name).not.toMatch(/[\u0000-\u001f]/);
    expect(f.item_name.startsWith("Invoice INV-1 xxx")).toBe(true);
  });
  it("omits empty optional fields instead of posting blanks", () => {
    env();
    expect(buildCheckout({ ...o, name: "  " }).fields).not.toHaveProperty("name_first");
  });
  it("amount comes from integer cents, never float arithmetic", () => {
    env();
    for (const [c, s] of [[1, "0.01"], [29, "0.29"], [10005, "100.05"], [1999999, "19999.99"]] as const)
      expect(buildCheckout({ ...o, amountCents: c }).fields.amount).toBe(s);
  });
  it("rejects a zero or fractional amount", () => {
    env();
    expect(() => buildCheckout({ ...o, amountCents: 0 })).toThrow("invalid_amount");
    expect(() => buildCheckout({ ...o, amountCents: 10.5 })).toThrow("invalid_amount");
  });
  it.each(["PAYFAST_MERCHANT_ID", "PAYFAST_MERCHANT_KEY"])("throws a clear error when %s is missing (also in production)", (name) => {
    env(); vi.stubEnv(name, ""); vi.stubEnv("NODE_ENV", "production");
    expect(() => buildCheckout(o)).toThrow(new RegExp(name));
  });
});

describe("isPayfastIp", () => {
  // [cidr, first, last, just below first, just above last]
  const edges: [string, string, string, string, string][] = [
    ["197.97.145.144/28", "197.97.145.144", "197.97.145.159", "197.97.145.143", "197.97.145.160"],
    ["41.74.179.192/27", "41.74.179.192", "41.74.179.223", "41.74.179.191", "41.74.179.224"],
    ["102.216.36.0/28", "102.216.36.0", "102.216.36.15", "102.216.35.255", "102.216.36.16"],
    ["102.216.36.128/28", "102.216.36.128", "102.216.36.143", "102.216.36.127", "102.216.36.144"],
    ["144.126.193.139/32", "144.126.193.139", "144.126.193.139", "144.126.193.138", "144.126.193.140"],
  ];
  it("the exported list is exactly the documented ranges", () => expect([...PAYFAST_IP_RANGES]).toEqual(edges.map((e) => e[0])));
  it.each(edges)("%s: first and last accepted, neighbours rejected", (_c, first, last, below, above) => {
    expect(isPayfastIp(first)).toBe(true);
    expect(isPayfastIp(last)).toBe(true);
    expect(isPayfastIp(below)).toBe(false);
    expect(isPayfastIp(above)).toBe(false);
  });
  it("accepts an address in the middle of a range", () => expect(isPayfastIp("197.97.145.150")).toBe(true));
  it("accepts the IPv4-mapped IPv6 form and surrounding whitespace", () => {
    expect(isPayfastIp("::ffff:197.97.145.150")).toBe(true);
    expect(isPayfastIp("::FFFF:197.97.145.150")).toBe(true);
    expect(isPayfastIp("  197.97.145.150 ")).toBe(true);
    expect(isPayfastIp("::ffff:1.2.3.4")).toBe(false);
  });
  it.each([
    "", " ", "1.2.3.4", "127.0.0.1", "10.0.0.1", "197.97.145", "197.97.145.150.1", "197.97.145.256", "197.97.145.-1", "197.97.145.1e2",
    "197.97.145.0150", "197.097.145.150", "0x C5.61.91.96", "197.97.145.150/28", "197.97.145.150:443", "197.97.145.150, 1.2.3.4", "abc",
    "::1", "2001:db8::1", "2001:4860:4860::8888", "::ffff:0:197.97.145.150", "::ffff:197.97.145", "undefined", "null",
  ])("rejects %j", (ip) => expect(isPayfastIp(ip)).toBe(false));
  it("tolerates non-string input", () => expect(isPayfastIp(undefined as unknown as string)).toBe(false));
});

describe("payfastValidate", () => {
  const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(impl));
  it("posts the ITN without the signature field to the host's /eng/query/validate and accepts only VALID", async () => {
    vi.stubEnv("PAYFAST_SANDBOX", "true");
    let seen: { url: string; body: string } | undefined;
    stubFetch(async (url, init) => { seen = { url, body: String(init.body) }; return new Response("VALID"); });
    expect(await payfastValidate("a=1&signature=abc&b=x+y")).toBe(true);
    expect(seen).toEqual({ url: "https://sandbox.payfast.co.za/eng/query/validate", body: "a=1&b=x+y" });
  });
  it("uses the live host by default", async () => {
    vi.stubEnv("PAYFAST_SANDBOX", "");
    let url = "";
    stubFetch(async (u) => { url = u; return new Response("VALID"); });
    await payfastValidate("a=1");
    expect(url).toBe("https://www.payfast.co.za/eng/query/validate");
  });
  it.each(["INVALID", "valid", "VALID but not", "", "NOT VALID"])("returns false for %j", async (t) => {
    stubFetch(async () => new Response(t));
    expect(await payfastValidate("a=1")).toBe(false);
  });
  it("throws on a network error and on HTTP 5xx (temporary: the caller answers 500)", async () => {
    stubFetch(async () => { throw new Error("down"); });
    await expect(payfastValidate("a=1")).rejects.toThrow("down");
    stubFetch(async () => new Response("oops", { status: 503 }));
    await expect(payfastValidate("a=1")).rejects.toThrow(/503/);
  });
  it("aborts after 8 seconds", async () => {
    vi.useFakeTimers();
    try {
      stubFetch((_u, init) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))));
      const p = payfastValidate("a=1");
      const assertion = expect(p).rejects.toThrow("aborted");
      await vi.advanceTimersByTimeAsync(7999);
      await vi.advanceTimersByTimeAsync(2);
      await assertion;
    } finally { vi.useRealTimers(); }
  });
});
