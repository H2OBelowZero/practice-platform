import { describe, it, expect, vi, afterEach } from "vitest";
import { runWorker, errorCode, BATCH_SIZE, MAX_BATCHES, type OutboxRow, type Rpc } from "@/lib/notify/worker";
import { ConsoleProvider, ProviderError, type Provider } from "@/lib/notify/provider";
import { TemplateError } from "@/lib/notify/templates";

// The worker against a fake database: rpc() answers like claim_outbox / finish_outbox / enqueue_* would.
const row = (id: number, o: Partial<OutboxRow> = {}): OutboxRow => ({
  id, channel: "email", template: "reminder_24h", recipient: `person${id}@example.test`, attempts: 1,
  payload: { date: "Mon 7 Jan 2030", time: "08:00", link: "/portal/appointments" }, ...o,
});

function fakeDb(batches: OutboxRow[][], o: { reminders?: number; overdue?: number; errors?: Record<string, string> } = {}) {
  const calls: { fn: string; args?: Record<string, unknown> }[] = [];
  let claimNo = 0;
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (o.errors?.[fn]) return { data: null, error: { code: o.errors[fn] } };
    if (fn === "enqueue_reminders") return { data: o.reminders ?? 0, error: null };
    if (fn === "enqueue_overdue_tasks") return { data: o.overdue ?? 0, error: null };
    if (fn === "claim_outbox") return { data: batches[claimNo++] ?? [], error: null };
    if (fn === "finish_outbox") return { data: null, error: null };
    throw new Error("unexpected rpc " + fn);
  };
  const finished = () => calls.filter((c) => c.fn === "finish_outbox").map((c) => c.args as { p_id: number; p_ok: boolean; p_error: string | null });
  return { rpc, calls, finished };
}
const sendOk = (): Provider & { sent: { to: string; subject: string }[] } => {
  const sent: { to: string; subject: string }[] = [];
  return { sent, send: async (_c, to, msg) => { sent.push({ to, subject: msg.subject }); } };
};

afterEach(() => vi.restoreAllMocks());

describe("runWorker", () => {
  it("queues reminders and overdue tasks first, then claims, sends and finishes each row", async () => {
    const db = fakeDb([[row(1), row(2)]], { reminders: 3, overdue: 1 });
    const p = sendOk();
    const r = await runWorker({ rpc: db.rpc, provider: () => p });
    expect(db.calls.map((c) => c.fn)).toEqual(["enqueue_reminders", "enqueue_overdue_tasks", "claim_outbox", "finish_outbox", "finish_outbox"]);
    expect(db.calls[2].args).toEqual({ p_limit: BATCH_SIZE });
    expect(db.finished()).toEqual([{ p_id: 1, p_ok: true, p_error: null }, { p_id: 2, p_ok: true, p_error: null }]);
    expect(p.sent.map((s) => s.to)).toEqual(["person1@example.test", "person2@example.test"]);
    expect(r).toMatchObject({ ok: true, reminders: 3, overdueTasks: 1, claimed: 2, sent: 2, retried: 0, failed: 0, deferred: 0, errors: [] });
  });

  it("a failing row never stops the batch; the failure is recorded as a short code, retried or failed by attempts", async () => {
    const db = fakeDb([[row(1), row(2, { attempts: 3 }), row(3)]]);
    const p: Provider = { send: async (_c, to) => { if (to.startsWith("person1") || to.startsWith("person2")) throw new ProviderError("provider_http_500"); } };
    const r = await runWorker({ rpc: db.rpc, provider: () => p });
    expect(db.finished()).toEqual([
      { p_id: 1, p_ok: false, p_error: "provider_http_500" }, { p_id: 2, p_ok: false, p_error: "provider_http_500" }, { p_id: 3, p_ok: true, p_error: null },
    ]);
    expect(r).toMatchObject({ ok: true, claimed: 3, sent: 1, retried: 1, failed: 1 });
  });

  it("maps errors to codes: provider and template codes pass through, anything else is 'send_failed' (never the message)", async () => {
    expect(errorCode(new ProviderError("provider_timeout"))).toBe("provider_timeout");
    expect(errorCode(new TemplateError("bad_link"))).toBe("bad_link");
    expect(errorCode(new Error("smtp said no to jane@example.test"))).toBe("send_failed");
    expect(errorCode("jane@example.test")).toBe("send_failed");
    const db = fakeDb([[row(1, { template: "nope" }), row(2, { payload: { link: "https://evil.test/x", date: "d", time: "t" } }), row(3)]]);
    const p: Provider = { send: async () => { throw new Error("secret jane@example.test body"); } };
    await runWorker({ rpc: db.rpc, provider: () => p });
    expect(db.finished().map((f) => f.p_error)).toEqual(["unknown_template", "bad_link", "send_failed"]);
    expect(JSON.stringify(db.calls)).not.toMatch(/secret/);
  });

  it("a provider that cannot be built (misconfigured) fails the row with its code", async () => {
    const db = fakeDb([[row(1)]]);
    await runWorker({ rpc: db.rpc, provider: () => { throw new ProviderError("provider_misconfigured"); } });
    expect(db.finished()).toEqual([{ p_id: 1, p_ok: false, p_error: "provider_misconfigured" }]);
  });

  it("claims in batches of 25 until a short batch, at most 4 batches (100 rows) per run", async () => {
    const full = (start: number) => Array.from({ length: BATCH_SIZE }, (_, i) => row(start + i));
    const db = fakeDb([full(1), full(100), full(200), full(300), full(400)]);
    const r = await runWorker({ rpc: db.rpc, provider: () => sendOk() });
    expect(db.calls.filter((c) => c.fn === "claim_outbox").length).toBe(MAX_BATCHES);
    expect(r.claimed).toBe(100);
    expect(r.sent).toBe(100);

    const db2 = fakeDb([full(1), [row(500)], full(600)]);
    const r2 = await runWorker({ rpc: db2.rpc, provider: () => sendOk() });
    expect(db2.calls.filter((c) => c.fn === "claim_outbox").length).toBe(2); // the short batch ends the run
    expect(r2.claimed).toBe(BATCH_SIZE + 1);

    const db3 = fakeDb([]);
    const r3 = await runWorker({ rpc: db3.rpc, provider: () => sendOk() });
    expect(db3.calls.filter((c) => c.fn === "claim_outbox").length).toBe(1);
    expect(r3).toMatchObject({ ok: true, claimed: 0 });
  });

  it("stops at the time budget and hands the unsent rows back (finish with 'run_budget'), without sending them", async () => {
    let t = 0;
    const db = fakeDb([[row(1), row(2), row(3)]]);
    const p: Provider = { send: async () => { t += 15_000; } }; // the first send takes 15 s
    const r = await runWorker({ rpc: db.rpc, provider: () => p, now: () => t, budgetMs: 20_000 });
    // 15 s elapsed after row 1 (< 20 s): row 2 is sent too (30 s), row 3 is deferred
    expect(db.finished()).toEqual([{ p_id: 1, p_ok: true, p_error: null }, { p_id: 2, p_ok: true, p_error: null }, { p_id: 3, p_ok: false, p_error: "run_budget" }]);
    expect(r).toMatchObject({ sent: 2, deferred: 1 });
    // and no further batch is started once the budget is spent
    expect(db.calls.filter((c) => c.fn === "claim_outbox").length).toBe(1);
  });

  it("an rpc error in one step is recorded as a code and the other steps still run", async () => {
    const db = fakeDb([[row(1)]], { errors: { enqueue_reminders: "42883" } });
    const r = await runWorker({ rpc: db.rpc, provider: () => sendOk() });
    expect(r).toMatchObject({ ok: false, sent: 1, errors: ["enqueue_reminders:42883"] });
    const db2 = fakeDb([[row(1)]], { errors: { claim_outbox: "rpc_unreachable" } });
    const r2 = await runWorker({ rpc: db2.rpc, provider: () => sendOk() });
    expect(r2).toMatchObject({ ok: false, claimed: 0, errors: ["claim_outbox:rpc_unreachable"] });
    const db3 = fakeDb([[row(1)]], { errors: { finish_outbox: "XX000" } });
    const r3 = await runWorker({ rpc: db3.rpc, provider: () => sendOk() });
    expect(r3).toMatchObject({ ok: false, errors: ["finish_outbox:XX000"] });
  });

  it("ignores malformed rows instead of crashing", async () => {
    const db = fakeDb([[null, 5, { id: "x" }, row(1)] as unknown as OutboxRow[]]);
    const r = await runWorker({ rpc: db.rpc, provider: () => sendOk() });
    expect(r).toMatchObject({ claimed: 1, sent: 1 });
  });

  it("the result and everything logged hold counts and codes only: no recipient, link or message text", async () => {
    const db = fakeDb([[row(1), row(2)]], { reminders: 2 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runWorker({ rpc: db.rpc, provider: () => new ConsoleProvider() });
    const text = JSON.stringify(r) + log.mock.calls.flat().join(" ") + err.mock.calls.flat().join(" ");
    expect(text).not.toMatch(/example\.test|portal|appointment|08:00/i);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      "[notify:console] id=1 template=reminder_24h channel=email", "[notify:console] id=2 template=reminder_24h channel=email",
    ]);
    expect(Object.keys(r).sort()).toEqual(["claimed", "deferred", "emailProvider", "errors", "failed", "ok", "overdueTasks", "reminders", "retried", "sent"]);
  });
});
