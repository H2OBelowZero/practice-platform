import { describe, it, expect } from "vitest";
import { buildCsp, makeNonce, supabaseConnectSources } from "@/lib/security/csp";

const nonce = "dGVzdC1ub25jZS0xMjM0NQ==";
const dir = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(name + " ") || d === name);
const prod = buildCsp({ nonce, isDev: false, supabaseUrl: "https://abcd.supabase.co" });
const dev = buildCsp({ nonce, isDev: true, supabaseUrl: "http://localhost:54321" });

describe("buildCsp, production", () => {
  it("script-src is self + this request's nonce + strict-dynamic, nothing else", () => {
    expect(dir(prod, "script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
  });
  it("has no unsafe-eval anywhere and no unsafe-inline for scripts", () => {
    expect(prod).not.toContain("unsafe-eval");
    expect(dir(prod, "script-src")).not.toContain("unsafe-inline");
    expect(dir(prod, "script-src")).not.toContain("*");
    expect(dir(prod, "script-src")).not.toMatch(/https?:/);
  });
  it("keeps unsafe-inline for styles only", () => {
    expect(dir(prod, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(prod.match(/unsafe-inline/g)).toHaveLength(1);
  });
  it("locks down framing, base, objects and forms", () => {
    expect(prod).toContain("default-src 'self'");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("base-uri 'self'");
    expect(prod).toContain("object-src 'none'");
    expect(dir(prod, "form-action")).toBe("form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za");
    expect(dir(prod, "img-src")).toBe("img-src 'self' data: blob:");
    expect(dir(prod, "font-src")).toBe("font-src 'self'");
  });
  it("upgrades insecure requests", () => expect(dir(prod, "upgrade-insecure-requests")).toBeDefined());
  it("derives the Supabase hosts from NEXT_PUBLIC_SUPABASE_URL, https and websocket", () => {
    expect(dir(prod, "connect-src")).toBe("connect-src 'self' https://abcd.supabase.co wss://abcd.supabase.co");
  });
  it("is one header-safe line", () => expect(prod).not.toMatch(/[\r\n]/));
});

describe("buildCsp, development", () => {
  it("adds unsafe-eval to script-src only, still with the nonce", () => {
    expect(dir(dev, "script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`);
    expect(dev.match(/unsafe-eval/g)).toHaveLength(1);
  });
  it("allows the local Supabase over http and ws, and does not force https", () => {
    expect(dir(dev, "connect-src")).toBe("connect-src 'self' http://localhost:54321 ws://localhost:54321");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });
});

describe("supabaseConnectSources (fails closed)", () => {
  it("keeps a custom domain and port", () => expect(supabaseConnectSources("https://db.example.org:8443/", false)).toEqual(["https://db.example.org:8443", "wss://db.example.org:8443"]));
  it.each([undefined, "", "  ", "not a url", "javascript:alert(1)", "ftp://x.test"])("throws in production for %j (no wildcard fallback)", (u) => {
    expect(() => supabaseConnectSources(u, false)).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(() => buildCsp({ nonce, isDev: false, supabaseUrl: u })).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
  it.each([undefined, "", "  "])("falls back to the local Supabase default in development for %j", (u) => {
    expect(supabaseConnectSources(u, true)).toEqual(["http://localhost:54321", "ws://localhost:54321"]);
  });
  it("still refuses a garbage URL in development", () => expect(() => supabaseConnectSources("nope", true)).toThrow());
  it("no CSP ever contains a wildcard host", () => {
    for (const csp of [prod, dev, buildCsp({ nonce, isDev: true })]) expect(csp).not.toMatch(/\*\.supabase\.co|https?:\/\/\*/);
  });
});

describe("nonce", () => {
  it("makeNonce is valid base64 and differs per call", () => {
    const a = makeNonce(), b = makeNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(a).not.toBe(b);
    expect(() => buildCsp({ nonce: a, isDev: false, supabaseUrl: "https://abcd.supabase.co" })).not.toThrow();
  });
  it.each(["", "short", "abc; script-src *  xxxxxxxxxxxxxxxxxxxxx", "bad'quote_xxxxxxxxxxxxxxxx", "has space xxxxxxxxxxxxxxxxxx", "line\nbreak_xxxxxxxxxxxxxxxxxx"])("refuses %j as a nonce", (n) => {
    expect(() => buildCsp({ nonce: n, isDev: false, supabaseUrl: "https://abcd.supabase.co" })).toThrow(/invalid nonce/);
  });
});
