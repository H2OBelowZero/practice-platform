import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { securityHeaders, noStoreSources } from "@/lib/security/headers";
import nextConfig from "@/next.config";

const rules = securityHeaders();
const get = (source: string) => Object.fromEntries((rules.find((r) => r.source === source)?.headers ?? []).map((h) => [h.key, h.value]));

describe("security headers", () => {
  const all = get("/:path*");
  it("sets every static header on all routes", () => {
    expect(all).toEqual({
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
  });
  it("does not preload HSTS", () => expect(all["Strict-Transport-Security"]).not.toContain("preload"));
  it("leaves the CSP to the middleware (it needs a per-request nonce)", () => {
    expect(JSON.stringify(rules)).not.toContain("Content-Security-Policy");
  });
  it("next.config serves exactly this config and hides X-Powered-By", async () => {
    expect(await nextConfig.headers!()).toEqual(rules);
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});

describe("no-store (R35)", () => {
  it("covers every authenticated or token-bearing prefix", () => {
    for (const s of ["/app/:path*", "/portal/:path*", "/api/:path*", "/login", "/mfa", "/recover/:path*", "/auth/:path*", "/book/confirmed"]) {
      expect(noStoreSources).toContain(s);
      expect(get(s)).toEqual({ "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" });
    }
  });
  it("covers every top-level route that is not public", () => {
    // Fails when someone adds an app/<area> that renders signed-in data without listing it above.
    const PUBLIC = new Set(["book"]); // marketing / booking pages may cache normally
    const top = readdirSync("app").filter((n) => statSync(join("app", n)).isDirectory() && !n.startsWith("("));
    const uncovered = top.filter((n) => !PUBLIC.has(n) && !noStoreSources.some((s) => s.startsWith(`/${n}/`) || s === `/${n}`));
    expect(uncovered).toEqual([]);
  });
  it("covers the route groups' authenticated pages (login, mfa, recover)", () => {
    for (const p of ["/login", "/mfa", "/recover"]) expect(noStoreSources.some((s) => s === p || s.startsWith(p + "/"))).toBe(true);
  });
  it("keeps marketing pages out of no-store", () => {
    for (const p of ["/", "/book", "/register", "/robots.txt"]) expect(noStoreSources).not.toContain(p);
  });
});
