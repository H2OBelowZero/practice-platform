import { describe, it, expect, vi, afterEach } from "vitest";
import { ConsoleProvider, ProviderError, ResendEmailProvider, emailProviderName, getProvider, smsActive } from "@/lib/notify/provider";

const MSG = { subject: "Appointment reminder", text: "You have an appointment on Mon 7 Jan 2030 at 08:00.", html: "<p>hi</p>" };
const TO = "jane.private@example.test";

afterEach(() => vi.restoreAllMocks());

describe("ConsoleProvider", () => {
  it("logs only the outbox id, template and channel: never the recipient, subject or body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new ConsoleProvider().send("email", TO, MSG, { id: 42, template: "reminder_24h" });
    const all = [...log.mock.calls, ...info.mock.calls, ...warn.mock.calls].flat().join(" ");
    expect(all).toBe("[notify:console] id=42 template=reminder_24h channel=email");
    expect(all).not.toContain(TO);
    expect(all).not.toMatch(/appointment|Appointment|08:00/);
  });
  it("copes without meta", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new ConsoleProvider().send("sms", "0821234567", MSG);
    expect(String(log.mock.calls[0][0])).not.toContain("0821234567");
  });
});

describe("ResendEmailProvider", () => {
  const ok = () => vi.fn(async () => new Response('{"id":"abc"}', { status: 200 }));

  it("posts to Resend with the bearer key, the configured sender and the message", async () => {
    const f = ok();
    await new ResendEmailProvider("re_key", "Booking <bookings@example.test>", f as unknown as typeof fetch).send("email", TO, MSG, { id: 7, template: "reminder_24h" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toBe("outbox-7");
    expect(JSON.parse(String(init.body))).toEqual({ from: "Booking <bookings@example.test>", to: [TO], subject: MSG.subject, text: MSG.text, html: MSG.html });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("omits html when the message has none", async () => {
    const f = ok();
    await new ResendEmailProvider("k", "a@b.test", f as unknown as typeof fetch).send("email", TO, { subject: "s", text: "t" });
    expect(Object.keys(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)))).toEqual(["from", "to", "subject", "text"]);
  });
  it("a non-2xx answer throws a short code and never includes the response body (it can echo the address or the key)", async () => {
    const f = vi.fn(async () => new Response(`{"message":"Invalid to address ${TO} for key re_key"}`, { status: 422 }));
    const err = await new ResendEmailProvider("re_key", "a@b.test", f as unknown as typeof fetch).send("email", TO, MSG).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("provider_http_422");
    expect(String(err.message) + String(err.stack)).not.toMatch(/jane|re_key|Invalid/);
  });
  it("a network failure becomes provider_network without the underlying message", async () => {
    const f = vi.fn(async () => { throw new TypeError(`connect failed for ${TO}`); });
    const err = await new ResendEmailProvider("k", "a@b.test", f as unknown as typeof fetch).send("email", TO, MSG).catch((e) => e);
    expect(err.code).toBe("provider_network");
    expect(err.message).not.toContain("jane");
  });
  it("aborts after 8 seconds and reports provider_timeout", async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn((_u: unknown, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
      const p = new ResendEmailProvider("k", "a@b.test", f as unknown as typeof fetch).send("email", TO, MSG).catch((e) => e);
      await vi.advanceTimersByTimeAsync(7_999);
      expect(f).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      expect((await p).code).toBe("provider_timeout");
    } finally { vi.useRealTimers(); }
  });
  it("only sends email", async () => {
    const f = ok();
    await expect(new ResendEmailProvider("k", "a@b.test", f as unknown as typeof fetch).send("sms", "0821234567", MSG)).rejects.toMatchObject({ code: "provider_wrong_channel" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("getProvider", () => {
  const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;

  it("email uses Resend when EMAIL_API_KEY and EMAIL_FROM are both set", () => {
    const e = env({ EMAIL_API_KEY: "k", EMAIL_FROM: "bookings@example.test", NODE_ENV: "production" });
    expect(getProvider("email", e)).toBeInstanceOf(ResendEmailProvider);
    expect(emailProviderName(e)).toBe("resend");
  });
  it("outside production with nothing configured the console is used (local runs show activity)", () => {
    for (const NODE_ENV of ["development", "test", ""]) {
      expect(emailProviderName(env({ NODE_ENV })), NODE_ENV).toBe("console");
      expect(getProvider("email", env({ NODE_ENV }))).toBeInstanceOf(ConsoleProvider);
    }
  });
  it("in production with nothing configured there is NO email provider: it never falls back to the console", () => {
    const e = env({ NODE_ENV: "production" });
    expect(emailProviderName(e)).toBe("none");
    expect(() => getProvider("email", e)).toThrow(/provider_not_configured/);
  });
  it("a key without a sender is not configured anywhere (half-finished setup)", () => {
    for (const NODE_ENV of ["production", "development"]) {
      for (const extra of [{} as Record<string, string>, { EMAIL_FROM: "   " }]) {
        const e = env({ NODE_ENV, EMAIL_API_KEY: "k", ...extra });
        expect(emailProviderName(e)).toBe("none");
        expect(() => getProvider("email", e)).toThrow(/provider_not_configured/);
      }
    }
  });
  it("SMS and push are always the console in Phase 1, even with email configured", () => {
    const e = env({ EMAIL_API_KEY: "k", EMAIL_FROM: "bookings@example.test", NODE_ENV: "production" });
    expect(getProvider("sms", e)).toBeInstanceOf(ConsoleProvider);
    expect(getProvider("push", e)).toBeInstanceOf(ConsoleProvider);
    expect(getProvider("sms", env({ NODE_ENV: "production" }))).toBeInstanceOf(ConsoleProvider);
  });
  it("SMS is active only for SMS_ACTIVE exactly 'true'", () => {
    expect(smsActive(env({ SMS_ACTIVE: "true" }))).toBe(true);
    for (const v of [undefined, "", "TRUE", "1", "yes", "false"]) expect(smsActive(env(v === undefined ? {} : { SMS_ACTIVE: v })), String(v)).toBe(false);
  });
});
