import { appUrl } from "@/lib/app-url";

/**
 * Notification templates (Task 15). PRIVACY RULES, enforced by tests/unit/templates.test.ts:
 *  - an email or text message can sit in a shared inbox or on a lock screen, so it says WHAT happened and WHERE to look, never more:
 *    no names, no clinical words, no amounts, no invoice numbers, no form names, no practice name. Subjects are fixed text (no dynamic values).
 *  - the only dynamic values are the date and time (formatted in SAST by whoever queued the row) and ONE link, which the worker re-checks here.
 *  - every email ends with the same footer (what to do in an emergency, and not to reply with personal information).
 */
export type Rendered = { subject: string; text: string; html?: string };

/** A failure the worker can store: only the short code ever leaves this module (finish_outbox keeps codes, not messages). */
export class TemplateError extends Error {
  constructor(readonly code: "unknown_template" | "bad_link" | "bad_data" | "missing_field" | "too_long") { super(code); this.name = "TemplateError"; }
}

export const FOOTER =
  "This message was sent by your practice's booking system. Do not reply with personal or health information. " +
  "If this is an emergency, call 10177 or go to the nearest emergency room.";

export const SUBJECT_MAX = 78;
export const TEXT_MAX = 1000;
export const SMS_MAX = 320;
const VALUE_MAX = 40;
const LINK_MAX = 500;

/**
 * Turn the stored link into the absolute link that is sent. The stored value is either a PATH ("/portal/appointments") or an absolute link
 * that already points at this app's own origin (older rows were queued as `${APP_URL}/portal/...`). Anything else is refused: a row written
 * with a foreign link (a phishing or open-redirect attempt, a typo in APP_URL) is never sent.
 */
export function absoluteLink(link: unknown, base: string = appUrl()): string {
  if (typeof link !== "string" || link.length === 0 || link.length > LINK_MAX || /[\s\u0000-\u001f\u007f\\]/.test(link)) throw new TemplateError("bad_link");
  if (link.startsWith("/")) {
    if (link.startsWith("//")) throw new TemplateError("bad_link"); // protocol-relative: another host
    return base + link;
  }
  try {
    const u = new URL(link);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.origin !== new URL(base).origin) throw new TemplateError("bad_link");
    return u.href;
  } catch { throw new TemplateError("bad_link"); }
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A date or time label from the queue: plain text, no control characters, short. */
function value(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!s) throw new TemplateError("missing_field");
  return s.slice(0, VALUE_MAX);
}

type Def = {
  subject: string;
  sms?: boolean;
  /** the sentence(s) before the link; `d` and `t` are the date and time labels (only read when `when` is set) */
  body: (d: string, t: string) => string;
  when?: boolean;
  /** the lead-in to the link, ends with a colon */
  cta: string;
};

// Wording is South African English and deliberately neutral. "appointment" is the only service word used.
const TEMPLATES: Record<string, Def> = {
  booking_confirmed: { subject: "Your appointment is confirmed", when: true, body: (d, t) => `Your appointment on ${d} at ${t} is confirmed.`, cta: "Manage it here:" },
  booking_requested: { subject: "We received your appointment request", when: true, body: (d, t) => `We have received your request for an appointment on ${d} at ${t}. We will confirm it soon.`, cta: "You can follow it here:" },
  appointment_cancelled: { subject: "Your appointment was cancelled", when: true, body: (d, t) => `Your appointment on ${d} at ${t} has been cancelled.`, cta: "You can book a new time here:" },
  appointment_rescheduled: { subject: "Your appointment has moved", when: true, body: (d, t) => `Your appointment is now on ${d} at ${t}.`, cta: "Manage it here:" },
  reminder_24h: { subject: "Appointment reminder", when: true, body: (d, t) => `You have an appointment on ${d} at ${t}.`, cta: "Manage it here:" },
  reminder_24h_sms: { subject: "Appointment reminder", sms: true, when: true, body: (d, t) => `Reminder: you have an appointment on ${d} at ${t}.`, cta: "Manage it:" },
  payment_receipt: { subject: "We received your payment", body: () => "We have received a payment.", cta: "View your receipt here:" },
  invoice_issued: { subject: "A new invoice is ready", body: () => "A new invoice is ready for you.", cta: "View and pay it here:" },
  portal_invite: { subject: "Set up your online account", body: () => "You have been invited to set up an online account.", cta: "Create your account here:" },
  form_requested: { subject: "A form is waiting for you", body: () => "You have a form to complete.", cta: "Open it here:" },
  form_returned: { subject: "A form needs your attention", body: () => "A form you completed has been returned to you for changes.", cta: "Open it here:" },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);
export const isTemplate = (name: unknown): name is string => typeof name === "string" && Object.hasOwn(TEMPLATES, name);

/**
 * Render a template from the stored payload ({date?, time?, link}). Unknown template, a missing date/time, a link that is not this app's, or output
 * over the length caps all throw a TemplateError (with a short code): the worker never sends a half-built message. Extra payload keys are ignored.
 */
export function renderTemplate(name: string, data: unknown, base?: string): Rendered {
  if (!isTemplate(name)) throw new TemplateError("unknown_template");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new TemplateError("bad_data");
  const def = TEMPLATES[name];
  const raw = data as { date?: unknown; time?: unknown; link?: unknown };
  const link = absoluteLink(raw.link, base);
  const body = def.body(def.when ? value(raw.date) : "", def.when ? value(raw.time) : "");

  if (def.sms) {
    const text = `${body} ${def.cta} ${link}`;
    if (text.length > SMS_MAX) throw new TemplateError("too_long");
    return { subject: def.subject, text };
  }
  const text = `${body}\n${def.cta} ${link}\n\n--\n${FOOTER}`;
  if (def.subject.length > SUBJECT_MAX || text.length > TEXT_MAX) throw new TemplateError("too_long");
  const html =
    `<!doctype html><html lang="en-ZA"><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2933;line-height:1.5">` +
    `<p>${escapeHtml(body)}</p>` +
    `<p>${escapeHtml(def.cta)} <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
    `<hr style="border:0;border-top:1px solid #d9dde1"><p style="color:#5c6168;font-size:13px">${escapeHtml(FOOTER)}</p></body></html>`;
  return { subject: def.subject, text, html };
}
