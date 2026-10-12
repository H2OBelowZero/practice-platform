import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ supabaseService: () => ({ rpc: h.rpc }) }));

import { GET, POST, dynamic, runtime, maxDuration } from "@/app/api/cron/reminders/route";

const URL = "http://localhost:3000/api/cron/reminders";
const SECRET = "a-long-random-cron-secret-0123456789";
const call = (method: "GET" | "POST", auth?: string) => (method === "GET" ? GET : POST)(new Request(URL, { method, headers: auth === undefined ? {} : { authorization: auth } }));
const good = `Bearer ${SECRET}`;

/** A fake database for the real worker: nothing to send unless a test says so. */
function db(o: { claim?: unknown[]; error?: Record<string, string>; auditError?: boolean; quiet?: boolean } = {}) {
  h.rpc.mockImplementation(async (fn: string) => {
    if (o.error?.[fn]) return { data: null, error: { code: o.error[fn], message: "secret db text" } };
    if (fn === "enqueue_reminders") return { data: o.quiet ? 0 : 2, error: null };
    if (fn === "enqueue_overdue_tasks") return { data: o.quiet ? 0 : 1, error: null };
    if (fn === "claim_outbox") { const rows = o.claim ?? []; o.claim = []; return { data: rows, error: null }; }
    if (fn === "finish_outbox" || fn === "release_outbox") return { data: null, error: null };
    if (fn === "audit_append") return o.auditError ? { data: null, error: { code: "42501", message: "no" } } : { data: null, error: null };
    throw new Error("unexpected " + fn);
  });
}

beforeEach(() => {
  h.rpc.mockReset();
  vi.stubEnv("CRON_SECRET", SECRET); vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("EMAIL_API_KEY", ""); vi.stubEnv("EMAIL_FROM", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("authorisation", () => {
  it("is a Node, never-cached route", () => {
    expect(runtime).toBe("nodejs");
    expect(dynamic).toBe("force-dynamic");
    expect(maxDuration).toBeGreaterThanOrEqual(30);
  });
  it("no header, a wrong secret, a wrong scheme or a prefix of the secret -> 401 and the database is never touched", async () => {
    db();
    for (const auth of [undefined, "", "Bearer ", "Bearer wrong", good + "x", `Bearer ${SECRET.slice(0, -1)}`, SECRET, `bearer ${SECRET}`, `Basic ${SECRET}`]) {
      for (const method of ["GET", "POST"] as const) {
        const r = await call(method, auth);
        expect(r.status, `${method} ${auth}`).toBe(401);
        expect(await r.json()).toEqual({ error: "unauthorized" });
        expect(r.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("CRON_SECRET unset or blank -> 500 misconfigured, even with a matching-looking header: the route is never open", async () => {
    db();
    for (const v of ["", "   "]) {
      vi.stubEnv("CRON_SECRET", v);
      for (const auth of [undefined, "Bearer ", `Bearer ${v}`, "Bearer undefined"]) {
        const r = await call("GET", auth);
        expect(r.status).toBe(500);
        expect(await r.json()).toEqual({ error: "misconfigured" });
      }
    }
    vi.unstubAllEnvs(); delete process.env.CRON_SECRET;
    expect((await call("GET", "Bearer undefined")).status).toBe(500);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("the comparison is constant time (hashes + timingSafeEqual) and lives in the route", () => {
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "reminders", "route.ts"), "utf8");
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).not.toMatch(/authorization["']?\)?\s*===/i);
  });
});

describe("a run", () => {
  it("GET and POST with the right bearer run the worker: reminders, overdue tasks, claim; audit row once", async () => {
    for (const method of ["GET", "POST"] as const) {
      db();
      const r = await call(method, good);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toMatchObject({ ok: true, reminders: 2, overdueTasks: 1, claimed: 0, sent: 0, errors: [], emailProvider: "console" });
      expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(["enqueue_reminders", "enqueue_overdue_tasks", "claim_outbox", "audit_append"]);
      h.rpc.mockReset();
    }
  });
  it("audits one cron.reminders.run row per run with counts only (no actor, no PII)", async () => {
    db({ claim: [{ id: 5, channel: "email", template: "reminder_24h", recipient: "jane@example.test", attempts: 1, payload: { date: "Mon 7 Jan 2030", time: "08:00", link: "/portal/appointments" } }] });
    await call("GET", good);
    const audits = h.rpc.mock.calls.filter((c) => c[0] === "audit_append");
    expect(audits.length).toBe(1);
    const a = audits[0][1];
    expect(a).toMatchObject({ p_actor: null, p_role: "system", p_action: "cron.reminders.run", p_entity: null, p_entity_id: null });
    expect(a.p_detail).toMatchObject({ reminders: 2, overdueTasks: 1, claimed: 1, sent: 1 });
    expect(JSON.stringify(a)).not.toMatch(/jane|example\.test|portal|08:00/);
  });
  it("sends through the provider and finishes the row; the response has counts only", async () => {
    db({ claim: [{ id: 5, channel: "email", template: "invoice_issued", recipient: "jane@example.test", attempts: 1, payload: { link: "/portal/payments" } }] });
    const r = await call("GET", good);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ sent: 1, claimed: 1 });
    expect(text).not.toMatch(/jane|example|portal/);
    expect(h.rpc.mock.calls.find((c) => c[0] === "finish_outbox")![1]).toEqual({ p_id: 5, p_ok: true, p_error: null });
  });
  it("no database (every rpc fails) -> 500 with codes only, handled without throwing", async () => {
    h.rpc.mockImplementation(async () => { throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:54321"); });
    const r = await call("GET", good);
    expect(r.status).toBe(500);
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toEqual(expect.arrayContaining(["enqueue_reminders:rpc_unreachable", "claim_outbox:rpc_unreachable"]));
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });
  it("a database error in one step is a 500 with the code; a failed audit write is reported too", async () => {
    db({ error: { enqueue_reminders: "42883" } });
    let r = await call("GET", good);
    expect(r.status).toBe(500);
    expect((await r.json()).errors).toEqual(["enqueue_reminders:42883"]);
    db({ auditError: true });
    r = await call("GET", good);
    expect(r.status).toBe(500);
    expect((await r.json()).errors).toEqual(["audit_append:42501"]);
  });
  it("never leaks a database message", async () => {
    db({ error: { claim_outbox: "XX000" } });
    const r = await call("GET", good);
    expect(JSON.stringify(await r.json())).not.toMatch(/secret db text/);
  });
});

describe("providers and quiet runs", () => {
  const prod = () => { vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("EMAIL_API_KEY", ""); vi.stubEnv("EMAIL_FROM", ""); };

  it("production without an email provider: queues, but claims and sends nothing, and says why", async () => {
    prod();
    db({ claim: [{ id: 5, channel: "email", template: "invoice_issued", recipient: "jane@example.test", attempts: 1, payload: { link: "/portal/payments" } }] });
    const r = await call("GET", good);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, reminders: 2, overdueTasks: 1, claimed: 0, sent: 0, skipped: "provider_not_configured", emailProvider: "none" });
    expect(h.rpc.mock.calls.map((c) => c[0])).toEqual(["enqueue_reminders", "enqueue_overdue_tasks", "audit_append"]);
    expect(h.rpc.mock.calls.some((c) => c[0] === "claim_outbox" || c[0] === "finish_outbox")).toBe(false);
  });
  it("development without a provider uses the console provider and claims email rows", async () => {
    vi.stubEnv("NODE_ENV", "development");
    db();
    const r = await call("GET", good);
    expect(await r.json()).toMatchObject({ emailProvider: "console" });
    expect(h.rpc.mock.calls.find((c) => c[0] === "claim_outbox")![1]).toEqual({ p_limit: 25, p_channels: ["email"] });
  });
  it("SMS_ACTIVE=true queues and claims sms as well; otherwise p_sms is false", async () => {
    db({ quiet: true });
    await call("GET", good);
    expect(h.rpc.mock.calls[0]).toEqual(["enqueue_reminders", { p_sms: false }]);
    h.rpc.mockReset(); db({ quiet: true });
    vi.stubEnv("SMS_ACTIVE", "true");
    await call("GET", good);
    expect(h.rpc.mock.calls[0]).toEqual(["enqueue_reminders", { p_sms: true }]);
    expect(h.rpc.mock.calls.find((c) => c[0] === "claim_outbox")![1].p_channels).toEqual(["email", "sms"]);
  });
  it("a quiet run (nothing queued, nothing claimed, no error) writes NO audit row; any activity or error does", async () => {
    db({ quiet: true });
    expect((await call("GET", good)).status).toBe(200);
    expect(h.rpc.mock.calls.some((c) => c[0] === "audit_append")).toBe(false);
    h.rpc.mockReset(); prod(); db({ quiet: true });
    await call("GET", good);
    expect(h.rpc.mock.calls.some((c) => c[0] === "audit_append")).toBe(false); // "skipped" alone is not activity
    h.rpc.mockReset(); db({ quiet: true, error: { claim_outbox: "XX000" } });
    vi.stubEnv("NODE_ENV", "test");
    await call("GET", good);
    expect(h.rpc.mock.calls.some((c) => c[0] === "audit_append")).toBe(true);
  });
});

describe("wiring", () => {
  const root = join(__dirname, "..", "..");
  it("vercel.json schedules the route every 15 minutes", () => {
    const cfg = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
    expect(cfg.crons).toEqual([{ path: "/api/cron/reminders", schedule: "*/15 * * * *" }]);
  });
  it("middleware does not run for /api/cron/ (no session, no Auth round trip), like /api/payfast/", () => {
    const src = readFileSync(join(root, "middleware.ts"), "utf8");
    const m = /matcher:\s*\["([^"]+)"\]/.exec(src)!;
    expect(m[1]).toContain("api/cron/");
    expect(m[1]).toContain("api/payfast/");
    const re = new RegExp("^" + m[1].replace(/\\\\/g, "\\") + "$");
    expect(re.test("/api/cron/reminders")).toBe(false);
    expect(re.test("/api/payfast/itn")).toBe(false);
    expect(re.test("/portal/settings")).toBe(true);
    expect(re.test("/api/other")).toBe(true);
  });
  it("is documented in .env.example", () => {
    const env = readFileSync(join(root, ".env.example"), "utf8");
    for (const k of ["CRON_SECRET", "EMAIL_API_KEY", "EMAIL_FROM"]) expect(env, k).toMatch(new RegExp(`^${k}=`, "m"));
  });
});

// ---- R34: every service-client rpc the notify code makes matches the SQL signature ---------------------------------------------------
const migrations = join(__dirname, "..", "..", "supabase", "migrations");
const sql = readdirSync(migrations).sort().map((f) => readFileSync(join(migrations, f), "utf8")).join("\n");
const sqlParams = (fn: string): string[] => {
  const defs = [...sql.matchAll(new RegExp("create (?:or replace )?function " + fn + "\\(([\\s\\S]*?)\\)\\s*returns", "g"))];
  if (defs.length === 0) throw new Error("no SQL function " + fn);
  return defs[defs.length - 1][1].split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
};
describe("rpc call sites match the SQL signatures (R34)", () => {
  const worker = readFileSync(join(__dirname, "..", "..", "lib", "notify", "worker.ts"), "utf8");
  const route = readFileSync(join(__dirname, "..", "..", "app", "api", "cron", "reminders", "route.ts"), "utf8");
  const keys = (src: string, fn: string) => {
    const at = src.indexOf(`rpc("${fn}"`);
    if (at < 0) throw new Error("no rpc " + fn);
    const body = src.slice(at, src.indexOf(");", at));
    return [...body.matchAll(/\b(p_[a-z_]+)\s*:/g)].map((m) => m[1]);
  };
  it("claim_outbox, finish_outbox, release_outbox, enqueue_reminders", () => {
    expect(keys(worker, "claim_outbox").sort()).toEqual(sqlParams("claim_outbox").sort());
    expect(keys(worker, "finish_outbox").sort()).toEqual(sqlParams("finish_outbox").sort());
    expect(keys(worker, "release_outbox").sort()).toEqual(sqlParams("release_outbox").sort());
    expect(keys(worker, "enqueue_reminders").sort()).toEqual(sqlParams("enqueue_reminders").sort());
    expect(sqlParams("claim_outbox")).toEqual(["p_limit", "p_channels"]);
    expect(sqlParams("enqueue_reminders")).toEqual(["p_sms"]);
  });
  it("enqueue_overdue_tasks takes no parameters", () => {
    expect(sqlParams("enqueue_overdue_tasks")).toEqual([]);
    expect(worker).toMatch(/rpc\("enqueue_overdue_tasks"\)/);
  });
  it("audit_append", () => {
    expect(keys(route, "audit_append").sort()).toEqual(sqlParams("audit_append").sort());
  });
  it("the worker never reads or writes the outbox table directly: only through the claim / finish functions", () => {
    expect(worker + route).not.toMatch(/from\(["']notifications_outbox["']\)/);
  });
});
