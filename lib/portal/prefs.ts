import { z } from "zod";

/**
 * Notification preferences (patients.comms_prefs, jsonb). The reminder queue (enqueue_reminders, 0022) sends a channel only when its key is exactly
 * true, so anything else (missing, "yes", null) reads as off here too.
 */
export type Prefs = { email: boolean; sms: boolean };

const asObject = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

export const readPrefs = (raw: unknown): Prefs => {
  const o = asObject(raw);
  return { email: o.email === true, sms: o.sms === true };
};

// A switch posts "on" when on and nothing when off; anything else is a tampered form.
const flag = z.optional(z.literal("on"));
const schema = z.object({ email: flag, sms: flag });

/** The form's values as preferences, or null when the form was not ours. */
export function parsePrefsInput(raw: unknown): Prefs | null {
  const o = asObject(raw);
  const v = schema.safeParse({ email: o.email, sms: o.sms });
  return v.success ? { email: v.data.email === "on", sms: v.data.sms === "on" } : null;
}

/** The stored object with email and sms replaced; any other key already stored is kept. */
export const mergePrefs = (existing: unknown, next: Prefs): Record<string, unknown> => ({ ...asObject(existing), email: next.email, sms: next.sms });

/** Names of the preferences that differ (audit detail: field names only, never values or contact details). */
export const changedFields = (before: Prefs, after: Prefs): string[] => (["email", "sms"] as const).filter((k) => before[k] !== after[k]);

export const PREFS_NOTICE = { saved: "Your choices are saved." } as const;
export const prefsNotice = (code: string | undefined): string | undefined =>
  code !== undefined && Object.hasOwn(PREFS_NOTICE, code) ? PREFS_NOTICE[code as keyof typeof PREFS_NOTICE] : undefined;

export const PREFS_ERROR = {
  invalid: "That did not look right. Please refresh the page and try again.",
  noRecord: "We could not find your record. Please contact the practice.",
  save: "We could not save your choices. Please try again.",
} as const;
