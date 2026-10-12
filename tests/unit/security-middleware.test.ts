import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_u: string, _k: string, o: { cookies: { setAll: (l: { name: string; value: string; options: object }[], hd: Record<string, string>) => void } }) => ({
    auth: { getUser: async () => { o.cookies.setAll([{ name: "sb-refreshed", value: "1", options: { path: "/" } }], { "Cache-Control": "no-store" }); return { data: { user: h.user } }; } },
  }),
}));

import { middleware, config } from "@/middleware";

const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3000${path}`, { headers });
const forwarded = (res: Response, name: string) => res.headers.get(`x-middleware-request-${name}`);

describe("middleware CSP", () => {
  it("sends a nonce CSP and forwards the same nonce to the app, different on every request", async () => {
    const a = await middleware(req("/"));
    const b = await middleware(req("/"));
    const csp = a.headers.get("content-security-policy")!;
    const n = forwarded(a, "x-nonce")!;
    expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(csp).toContain(`'nonce-${n}'`);
    expect(forwarded(a, "content-security-policy")).toBe(csp); // Next reads the REQUEST header to stamp its scripts
    expect(forwarded(b, "x-nonce")).not.toBe(n);
  });
  it("overwrites a client-supplied nonce, CSP and x-pathname", async () => {
    const res = await middleware(req("/book?x=1", { "x-nonce": "evil", "content-security-policy": "default-src *", "x-pathname": "/app" }));
    expect(forwarded(res, "x-nonce")).not.toBe("evil");
    expect(forwarded(res, "content-security-policy")).not.toContain("default-src *");
    expect(forwarded(res, "x-pathname")).toBe("/book?x=1");
  });
  it("still refreshes the Supabase cookie and keeps its no-store header alongside the CSP", async () => {
    const res = await middleware(req("/"));
    expect(res.headers.get("set-cookie")).toContain("sb-refreshed=1");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("script-src");
  });
  it("redirects anonymous visitors from /app with the CSP and the refreshed cookie", async () => {
    const res = await middleware(req("/app/billing"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fapp%2Fbilling");
    expect(res.headers.get("content-security-policy")).toContain("script-src");
    expect(res.headers.get("set-cookie")).toContain("sb-refreshed=1");
  });
  it("lets a signed-in user through", async () => {
    h.user = { id: "u" };
    expect((await middleware(req("/app"))).status).toBe(200);
    h.user = null;
  });
});

describe("matcher", () => {
  const re = new RegExp(`^${config.matcher[0]}$`);
  it.each(["/api/payfast/itn", "/api/cron/reminders", "/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/icon.svg"])("excludes %s", (p) => expect(re.test(p)).toBe(false));
  it.each(["/", "/login", "/app", "/portal/payments", "/book/confirmed", "/robots.txt", "/api/other"])("includes %s", (p) => expect(re.test(p)).toBe(true));
});
