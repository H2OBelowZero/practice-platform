import { getProvider, emailProviderName, ProviderError, type Channel, type Provider } from "./provider";
import { renderTemplate, TemplateError } from "./templates";

/**
 * The outbox worker (Task 15), written against a tiny `rpc` function so it can be tested without a database. The cron route wires it to the
 * service-role Supabase client. Order of a run: queue the reminders, queue the overdue-invoice tasks, then claim due rows in batches, render each one,
 * send it and record the outcome. Everything it returns or logs is a count or a short code: never a recipient, a subject, a body or a provider reply.
 */
export type OutboxRow = { id: number; channel: Channel; template: string; recipient: string; payload: unknown; attempts: number };
export type RpcResult = { data: unknown; error: { code: string } | null };
export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>;
export type WorkerDeps = { rpc: Rpc; provider?: (channel: Channel) => Provider; now?: () => number; budgetMs?: number };

export const BATCH_SIZE = 25;
export const MAX_BATCHES = 4;      // at most 100 rows per run
export const BUDGET_MS = 20_000;
export const MAX_ATTEMPTS = 3;     // mirrors claim_outbox / finish_outbox

export type RunResult = {
  ok: boolean;
  reminders: number; overdueTasks: number;
  claimed: number; sent: number; retried: number; failed: number; deferred: number;
  emailProvider: "resend" | "console";
  errors: string[];
};

/** The code stored for a failure. Anything that is not one of ours becomes "send_failed": error messages can contain addresses or provider replies. */
export function errorCode(e: unknown): string {
  if (e instanceof ProviderError || e instanceof TemplateError) return e.code;
  return "send_failed";
}

const asCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isRow = (r: unknown): r is OutboxRow =>
  !!r && typeof r === "object" && typeof (r as OutboxRow).id === "number" && typeof (r as OutboxRow).template === "string" && typeof (r as OutboxRow).recipient === "string";

export async function runWorker(deps: WorkerDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const providerFor = deps.provider ?? ((c: Channel) => getProvider(c));
  const budget = deps.budgetMs ?? BUDGET_MS;
  const started = now();
  const out: RunResult = { ok: true, reminders: 0, overdueTasks: 0, claimed: 0, sent: 0, retried: 0, failed: 0, deferred: 0, emailProvider: emailProviderName(), errors: [] };
  const fail = (what: string, code: string) => { out.errors.push(`${what}:${code}`); };

  const enq = await deps.rpc("enqueue_reminders");
  if (enq.error) fail("enqueue_reminders", enq.error.code); else out.reminders = asCount(enq.data);
  const over = await deps.rpc("enqueue_overdue_tasks");
  if (over.error) fail("enqueue_overdue_tasks", over.error.code); else out.overdueTasks = asCount(over.data);

  const finish = async (id: number, ok: boolean, code: string | null) => {
    const r = await deps.rpc("finish_outbox", { p_id: id, p_ok: ok, p_error: code });
    if (r.error) fail("finish_outbox", r.error.code); // the row stays 'sending' and is claimed again after 10 minutes
  };

  for (let batch = 0; batch < MAX_BATCHES && now() - started < budget; batch++) {
    const got = await deps.rpc("claim_outbox", { p_limit: BATCH_SIZE });
    if (got.error) { fail("claim_outbox", got.error.code); break; }
    const rows = (Array.isArray(got.data) ? got.data : []).filter(isRow);
    if (rows.length === 0) break;
    out.claimed += rows.length;

    // One at a time: providers rate-limit bursts, and a failing row must not affect the next. A run that is out of time hands the rest back.
    for (const row of rows) {
      if (now() - started >= budget) { out.deferred++; await finish(row.id, false, "run_budget"); continue; }
      let code: string | null = null;
      try {
        const msg = renderTemplate(row.template, row.payload);
        await providerFor(row.channel).send(row.channel, row.recipient, msg, { id: row.id, template: row.template });
      } catch (e) { code = errorCode(e); }
      await finish(row.id, code === null, code);
      if (code === null) out.sent++;
      else if (row.attempts >= MAX_ATTEMPTS) out.failed++;
      else out.retried++;
    }
    if (rows.length < BATCH_SIZE) break;
  }
  out.ok = out.errors.length === 0;
  return out;
}
