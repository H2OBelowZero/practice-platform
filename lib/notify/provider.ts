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

/** True once a real SMS provider exists. Phase 1 has none: SMS rows are logged only, and the portal says so. */
export const SMS_ACTIVE = false;

/** Which email provider is configured: "resend" when EMAIL_API_KEY and EMAIL_FROM are both set, otherwise "console" (logs only, nothing is delivered). */
export const emailProviderName = (env: NodeJS.ProcessEnv = process.env): "resend" | "console" =>
  env.EMAIL_API_KEY?.trim() && env.EMAIL_FROM?.trim() ? "resend" : "console";

export function getProvider(channel: Channel, env: NodeJS.ProcessEnv = process.env): Provider {
  // a key without a sender is a half-finished setup: fail the sends (visible as failed rows) instead of silently dropping real email into the log
  if (channel === "email" && env.EMAIL_API_KEY?.trim() && !env.EMAIL_FROM?.trim()) throw new ProviderError("provider_misconfigured");
  if (channel === "email" && emailProviderName(env) === "resend") return new ResendEmailProvider(env.EMAIL_API_KEY!.trim(), env.EMAIL_FROM!.trim());
  return new ConsoleProvider();
}
