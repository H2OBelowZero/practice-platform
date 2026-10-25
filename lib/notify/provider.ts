import type { Rendered } from "./templates";

export type Channel = "email" | "sms" | "push";
/** What the worker knows about the row being sent. Only these two fields may ever be logged. */
export type SendMeta = { id: number; template: string };

export interface Provider {
  send(channel: Channel, to: string, msg: Rendered, meta?: SendMeta): Promise<void>;
}

/** A provider failure with a short code ("provider_http_422", "provider_timeout", "provider_network"). Never carries a response body, a recipient or a key. */
export class ProviderError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ProviderError"; }
}

/**
 * Logs that a message WOULD have been sent: outbox id, template and channel ONLY. Never the recipient, subject or body (a log line outlives the message
 * and is read by more people). This is what SMS and push use in Phase 1, and email until a provider is configured.
 */
export class ConsoleProvider implements Provider {
  async send(channel: Channel, _to: string, _msg: Rendered, meta?: SendMeta): Promise<void> {
    console.log(`[notify:console] id=${meta?.id ?? "?"} template=${meta?.template ?? "?"} channel=${channel}`);
  }
}

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 8_000;

/**
 * Email through Resend's HTTP API. A PLACEHOLDER CHOICE: the practice owner confirms the real provider (see README). The key and the sender address
 * come from EMAIL_API_KEY and EMAIL_FROM. A non-2xx answer throws `provider_http_<status>` and discards the response body (it can echo the recipient).
 */
export class ResendEmailProvider implements Provider {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async send(channel: Channel, to: string, msg: Rendered, meta?: SendMeta): Promise<void> {
    if (channel !== "email") throw new ProviderError("provider_wrong_channel");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          // a row re-claimed after a crash is sent with the same key, so the provider can drop the duplicate
          ...(meta ? { "Idempotency-Key": `outbox-${meta.id}` } : {}),
        },
        body: JSON.stringify({ from: this.from, to: [to], subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new ProviderError(`provider_http_${res.status}`);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(ctl.signal.aborted ? "provider_timeout" : "provider_network");
    } finally { clearTimeout(timer); }
  }
}

/**
 * SMS is switched on only by SMS_ACTIVE=true, and that must be set only once a real SMS provider is wired in (Phase 1 has none: the SMS provider is the
 * console one, which delivers nothing). While it is off no SMS reminder rows are queued and any SMS rows already queued are never claimed.
 */
export const smsActive = (env: NodeJS.ProcessEnv = process.env): boolean => env.SMS_ACTIVE === "true";

export type SmsProviderName = "console" | "none";

/**
 * Which SMS provider is usable. Phase 1 has no real one, so: "console" outside production (local runs log that a message would have gone; nothing is
 * delivered) and "none" in production. With "none" the worker neither queues nor claims SMS rows even when SMS_ACTIVE is true, so no row is ever marked
 * 'sent' for a message nobody received (the same rule as email without a provider). Wiring a real provider means changing this function and getProvider.
 */
export const smsProviderName = (env: NodeJS.ProcessEnv = process.env): SmsProviderName => (env.NODE_ENV === "production" ? "none" : "console");

export type EmailProviderName = "resend" | "console" | "none";

/**
 * Which email provider is usable:
 *  - "resend" when EMAIL_API_KEY and EMAIL_FROM are both set;
 *  - "none" when a key is set without a sender (half-finished setup), or in production with nothing set: the worker then sends NOTHING and leaves the rows
 *    pending (it never pretends that an email was delivered);
 *  - "console" only outside production with nothing set (local runs show activity in the log; nothing is delivered).
 */
export function emailProviderName(env: NodeJS.ProcessEnv = process.env): EmailProviderName {
  const key = env.EMAIL_API_KEY?.trim(), from = env.EMAIL_FROM?.trim();
  if (key && from) return "resend";
  if (key) return "none";
  return env.NODE_ENV === "production" ? "none" : "console";
}

export function getProvider(channel: Channel, env: NodeJS.ProcessEnv = process.env): Provider {
  if (channel === "email") {
    const name = emailProviderName(env);
    if (name === "none") throw new ProviderError("provider_not_configured");
    if (name === "resend") return new ResendEmailProvider(env.EMAIL_API_KEY!.trim(), env.EMAIL_FROM!.trim());
    return new ConsoleProvider();
  }
  // SMS and push: the console provider delivers nothing, so it is never used in production (a send there would mark a row 'sent' that nobody received)
  if (smsProviderName(env) === "none") throw new ProviderError("provider_not_configured");
  return new ConsoleProvider();
}
