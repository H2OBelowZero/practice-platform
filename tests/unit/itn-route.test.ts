import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ processItn: vi.fn(), supabaseService: vi.fn() }));
vi.mock("@/lib/payments/itn", async (orig) => {
  const actual = await orig<typeof import("@/lib/payments/itn")>();
  h.processItn.mockImplementation(actual.processItn);
  return { ...actual, processItn: (...a: Parameters<typeof actual.processItn>) => h.processItn(...a) };
});
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => h.supabaseService() }));

import { GET, POST, dynamic, runtime } from "@/app/api/payfast/itn/route";
import { payfastSignature } from "@/lib/payments/payfast";
import { MAX_BODY_BYTES } from "@/lib/payments/itn";

// the module is mocked above; this is the unmocked core
const realProcess = (...a: Parameters<typeof import("@/lib/payments/itn").processItn>) =>
  vi.importActual<typeof import("@/lib/payments/itn")>("@/lib/payments/itn").then((m) => m.processItn(...a));

const URL = "http://localhost:3000/api/payfast/itn";
const post = (body: string, headers: Record<string, string> = {}) => POST(new Request(URL, { method: "POST", body, headers }));

beforeEach(() => {
  h.processItn.mockReset();
  h.processItn.mockResolvedValue({ status: 200, body: "OK", outcome: "recorded" });
  h.supabaseService.mockReset();
  h.supabaseService.mockReturnValue({});
  vi.stubEnv("PAYFAST_MERCHANT_ID", " 10000100 "); vi.stubEnv("PAYFAST_PASSPHRASE", "pp"); vi.stubEnv("PAYFAST_SANDBOX", "true");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const ipSeen = () => h.processItn.mock.calls[0][1].sourceIp as string;

describe("ITN route", () => {
  it("is a Node, never-cached route", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
  });
  it("GET -> 405 with Allow: POST and no body detail", async () => {
    const r = await GET();
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("passes the status and body of processItn through, uncached, as plain text", async () => {
    h.processItn.mockResolvedValue({ status: 400, body: "rejected", outcome: "bad_signature" });
    const r = await post("a=1");
    expect(r.status).toBe(400);
    expect(await r.text()).toBe("rejected");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toMatch(/^text\/plain/);
  });
  it("hands the raw body and trimmed env (merchant id, passphrase, sandbox flag) to the core", async () => {
    await post("m_payment_id=x&amount_gross=1.00");
    const [deps, input] = h.processItn.mock.calls[0];
    expect(input.rawBody).toBe("m_payment_id=x&amount_gross=1.00");
    expect(deps.env).toEqual({ merchantId: "10000100", passphrase: "pp", sandbox: true });
  });
  it("sandbox flag is true only for the exact string 'true'", async () => {
    vi.stubEnv("PAYFAST_SANDBOX", "TRUE");
    await post("a=1");
    expect(h.processItn.mock.calls[0][0].env.sandbox).toBe(false);
  });

  describe("client IP", () => {
    it("x-vercel-forwarded-for takes precedence over x-forwarded-for", async () => {
      await post("a=1", { "x-vercel-forwarded-for": "197.97.145.150", "x-forwarded-for": "1.2.3.4" });
      expect(ipSeen()).toBe("197.97.145.150");
    });
    it("uses the first x-forwarded-for entry, trimmed", async () => {
      await post("a=1", { "x-forwarded-for": " 197.97.145.151 , 10.0.0.1, 1.2.3.4" });
      expect(ipSeen()).toBe("197.97.145.151");
    });
    it("uses the first entry of x-vercel-forwarded-for too", async () => {
      await post("a=1", { "x-vercel-forwarded-for": "41.74.179.200, 10.0.0.1" });
      expect(ipSeen()).toBe("41.74.179.200");
    });
    it("no header -> empty string (the core rejects it)", async () => {
      await post("a=1");
      expect(ipSeen()).toBe("");
    });
  });

  describe("oversize bodies", () => {
    const real = () => h.processItn.mockImplementation(realProcess);
    it("a declared content-length over the limit is refused by the core as body_too_large without buffering", async () => {
      real();
      const r = await post("a=1", { "content-length": String(MAX_BODY_BYTES + 1) });
      expect(r.status).toBe(400);
      expect(h.processItn.mock.calls[0][1].rawBody.length).toBeGreaterThan(MAX_BODY_BYTES);
    });
    it("a streamed body over the limit (no content-length) is cut off and refused", async () => {
      real();
      const big = "a=" + "x".repeat(MAX_BODY_BYTES * 3);
      const r = await post(big);
      expect(r.status).toBe(400);
      expect(await r.text()).toBe("rejected");
    });
    it("a body exactly at the limit is read whole", async () => {
      const exact = "a=" + "x".repeat(MAX_BODY_BYTES - 2);
      await post(exact);
      expect(h.processItn.mock.calls[0][1].rawBody).toBe(exact);
    });
    it("an empty body reaches the core as an empty string", async () => {
      await POST(new Request(URL, { method: "POST" }));
      expect(h.processItn.mock.calls[0][1].rawBody).toBe("");
    });
  });

  describe("failures never leak and never crash", () => {
    it("a dependency that throws (service client cannot be built) -> 500 'error'", async () => {
      h.supabaseService.mockImplementation(() => { throw new Error("SECRET connection string"); });
      const r = await post("a=1");
      expect(r.status).toBe(500);
      expect(await r.text()).toBe("error");
    });
    it("the core throwing -> 500 'error', no detail", async () => {
      h.processItn.mockRejectedValue(new Error("SECRET internals"));
      const r = await post("a=1");
      expect(r.status).toBe(500);
      expect(await r.text()).toBe("error");
      expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain("SECRET");
    });
    it("a database that throws on every call: unsigned garbage is a 400 and never reaches it, a signed ITN is a 500 (PayFast retries)", async () => {
      h.processItn.mockImplementation(realProcess);
      const boom = () => { throw new Error("db down"); };
      h.supabaseService.mockReturnValue({ from: boom, rpc: boom });
      expect((await post("garbage")).status).toBe(400);
      const pairs: [string, string][] = [["m_payment_id", "0b8e7e0a-2a77-4a52-8b1c-1d3d54cb0d11"], ["pf_payment_id", "1"], ["payment_status", "COMPLETE"], ["amount_gross", "950.00"], ["merchant_id", "10000100"]];
      const body = new URLSearchParams([...pairs, ["signature", payfastSignature(pairs, "pp", { includeEmpty: true })]]).toString();
      const r = await post(body, { "x-forwarded-for": "197.97.145.150" });
      expect(r.status).toBe(500);
      expect(await r.text()).toBe("error");
    });
  });
});
