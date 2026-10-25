import { getProvider, emailProviderName, smsActive, smsProviderName, ProviderError, type Channel, type EmailProviderName, type Provider, type SmsProviderName } from "./provider";
import { renderTemplate, TemplateError } from "./templates";

/**
 * The outbox worker (Task 15), written against a tiny `rpc` function so it can be tested without a database. The cron route wires it to the
 * service-role Supabase client. Order of a run: queue the reminders, queue the overdue-invoice tasks, then claim due rows in batches, render each one,
 * send it and record the outcome. Everything it returns or logs is a count or a short code: never a recipient, a subject, a body or a provider reply.
 *
 * Nothing is claimed for a channel that cannot really be sent: with no email provider configured (production without EMAIL_API_KEY / EMAIL_FROM) email
 * rows stay pending, and while SMS is switched off, or switched on without an SMS provider (production in Phase 1), no SMS row is queued or claimed.
 * claim_outbox expires rows that went stale in the meantime.
 */
export type OutboxRow = { id: number; channel: Channel; template: string; recipient: string; payload: unknown; attempts: number };
export type RpcResult = { data: unknown; error: { code: string } | null };
export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>;
export type WorkerDeps = {
  rpc: Rpc; provider?: (channel: Channel) => Provider; now?: () => number; budgetMs?: number;
  emailProvider?: EmailProviderName; smsActive?: boolean; smsProvider?: SmsProviderName;
};

export const BATCH_SIZE = 25;
export const MAX_BATCHES = 4;      // at most 100 rows per run
export const BUDGET_MS = 20_000;
export const MAX_ATTEMPTS = 3;     // mirrors claim_outbox / finish_outbox

export type RunResult = {
  ok: boolean;
  reminders: number; overdueTasks: number;
  claimed: number; sent: number; retried: number; failed: number; deferred: number;
  emailProvider: EmailProviderName;
  /** set when email rows were left untouched because no email provider is configured */
  skipped?: "provider_not_configured";
  /** set when SMS_ACTIVE is true but there is no SMS provider (production in Phase 1): SMS rows are neither queued nor claimed */
  smsSkipped?: "provider_not_configured";
  errors: string[];
};

/** The code stored for a failure. Anything that is not one of ours becomes "send_failed": error messages can contain addresses or provider replies. */
export function errorCode(e: unknown): string {
  if (e instanceof ProviderError || e instanceof TemplateError) return e.code;
  return "send_failed";
}

/** True when the run did anything worth an audit row: a count above zero, or an error. */
export const somethingHappened = (r: RunResult): boolean =>
  r.errors.length > 0 || [r.reminders, r.overdueTasks, r.claimed, r.sent, r.retried, r.failed, r.deferred].some((n) => n > 0);

const asCount = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isRow = (r: unknown): r is OutboxRow =>
  !!r && typeof r === "object" && typeof (r as OutboxRow).id === "number" && typeof (r as OutboxRow).template === "string" && typeof (r as OutboxRow).recipient === "string";

export async function runWorker(deps: WorkerDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const providerFor = deps.provider ?? ((c: Channel) => getProvider(c));
  const budget = deps.budgetMs ?? BUDGET_MS;
  const emailName = deps.emailProvider ?? emailProviderName();
  // SMS goes out only when it is switched on AND a provider can really send it; in production Phase 1 has none (the console provider delivers nothing)
  const smsOn = deps.smsActive ?? smsActive();
  const sms = smsOn && (deps.smsProvider ?? smsProviderName()) !== "none";
  const started = now();
  const out: RunResult = { ok: true, reminders: 0, overdueTasks: 0, claimed: 0, sent: 0, retried: 0, failed: 0, deferred: 0, emailProvider: emailName, errors: [] };
  const fail = (what: string, code: string) => { out.errors.push(`${what}:${code}`); };

  const enq = await deps.rpc("enqueue_reminders", { p_sms: sms });
  if (enq.error) fail("enqueue_reminders", enq.error.code); else out.reminders = asCount(enq.data);
  const over = await deps.rpc("enqueue_overdue_tasks");
  if (over.error) fail("enqueue_overdue_tasks", over.error.code); else out.overdueTasks = asCount(over.data);

  const channels: Channel[] = [];
  if (emailName !== "none") channels.push("email"); else { out.skipped = "provider_not_configured"; console.log("[notify] no email provider configured: email rows left pending"); }
  if (sms) channels.push("sms"); else if (smsOn) { out.smsSkipped = "provider_not_configured"; console.log("[notify] SMS is switched on but no SMS provider is configured: no SMS rows queued or claimed"); }

  const finish = async (id: number, ok: boolean, code: string | null) => {
    const r = await deps.rpc("finish_outbox", { p_id: id, p_ok: ok, p_error: code });
    if (r.error) fail("finish_outbox", r.error.code); // the row stays 'sending' and is claimed again after 10 minutes
  };

  for (let batch = 0; channels.length > 0 && batch < MAX_BATCHES && now() - started < budget; batch++) {
    const got = await deps.rpc("claim_outbox", { p_limit: BATCH_SIZE, p_channels: channels });
    if (got.error) { fail("claim_outbox", got.error.code); break; }
    const all = Array.isArray(got.data) ? got.data : [];
    if (all.length === 0) break;

    // A claimed row we cannot read is an error, not something to drop: it is finished as failed with a code so it is retried and then reported.
    for (const bad of all.filter((r) => !isRow(r))) {
      fail("claim_outbox", "malformed_row");
      const id = (bad as { id?: unknown } | null)?.id;
      if (typeof id === "number") await finish(id, false, "malformed_row");
    }
    const rows = all.filter(isRow);
    out.claimed += rows.length;

    // One at a time: providers rate-limit bursts, and a failing row must not affect the next. A run that is out of time hands the rest back
    // (release_outbox) WITHOUT using up an attempt.
    for (const row of rows) {
      if (now() - started >= budget) {
        out.deferred++;
        const r = await deps.rpc("release_outbox", { p_id: row.id });
        if (r.error) fail("release_outbox", r.error.code);
        continue;
      }
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
    if (all.length < BATCH_SIZE) break;
  }
  out.ok = out.errors.length === 0;
  return out;
}
