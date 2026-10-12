import { sastDate, sastTime } from "@/lib/time";

/**
 * The audit viewer shows what a row's `detail` says, but only from a WHITELIST of keys, and only when the value has the expected shape
 * (an id that is a uuid, a count that is a whole number, a code made of lower-case letters, digits and _ . : -). Any other key, and any value of the
 * wrong shape, is dropped without a trace, so free text that should never have been in the log cannot reach the screen or a CSV export.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9][a-z0-9_.:-]{0,47}$/;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const ID_KEYS = ["patient_id", "invoice_id", "claim_id", "appointment_id", "payment_id", "note_id", "member_id", "submission_id", "task_id"] as const;
const COUNT_KEYS = ["version", "count", "rows", "attempts", "page", "reminders", "overdueTasks", "claimed", "sent", "retried", "failed", "deferred"] as const;
const CODE_KEYS = ["reason", "status", "method", "template", "channel", "outcome", "code", "by_role", "report"] as const;
const DATE_KEYS = ["from", "to"] as const; // YYYY-MM-DD, the period of a report export
const FLAG_KEYS = ["late", "duplicate_confirmed", "truncated"] as const;
const LIST_KEYS = ["fields", "filters"] as const; // lists of field / filter NAMES
const COUNTED_KEYS = ["errors"] as const; // shown as how many, never as the text

export const AUDIT_DETAIL_KEYS: readonly string[] = [...ID_KEYS, ...COUNT_KEYS, ...CODE_KEYS, ...DATE_KEYS, ...FLAG_KEYS, ...LIST_KEYS, ...COUNTED_KEYS];

const label = (k: string) => k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const shortId = (id: string) => id.slice(0, 8);

/** The safe parts of an audit detail as short "label: value" strings, in a fixed order. Never throws; anything unexpected gives []. */
export function auditDetailParts(detail: unknown): string[] {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
  const d = detail as Record<string, unknown>;
  const has = (k: string) => Object.hasOwn(d, k);
  const out: string[] = [];
  for (const k of ID_KEYS) if (has(k) && typeof d[k] === "string" && UUID.test(d[k] as string)) out.push(`${label(k)}: ${shortId(d[k] as string)}`);
  for (const k of COUNT_KEYS) if (has(k) && typeof d[k] === "number" && Number.isSafeInteger(d[k]) && (d[k] as number) >= 0) out.push(`${label(k)}: ${d[k]}`);
  for (const k of CODE_KEYS) if (has(k) && typeof d[k] === "string" && CODE.test(d[k] as string)) out.push(`${label(k)}: ${d[k]}`);
  for (const k of DATE_KEYS) if (has(k) && typeof d[k] === "string" && DATE.test(d[k] as string)) out.push(`${label(k)}: ${d[k]}`);
  for (const k of FLAG_KEYS) if (has(k) && typeof d[k] === "boolean") out.push(`${label(k)}: ${d[k] ? "yes" : "no"}`);
  for (const k of LIST_KEYS) {
    if (!has(k) || !Array.isArray(d[k])) continue;
    const names = (d[k] as unknown[]).filter((x): x is string => typeof x === "string" && NAME.test(x)).slice(0, 12);
    if (names.length) out.push(`${label(k)}: ${names.join(", ")}`);
  }
  for (const k of COUNTED_KEYS) if (has(k) && Array.isArray(d[k]) && (d[k] as unknown[]).length > 0) out.push(`${label(k)}: ${(d[k] as unknown[]).length}`);
  return out;
}

export const auditDetailSummary = (detail: unknown): string => auditDetailParts(detail).join("; ");

/** The eight characters shown for an entity id; the full id is available as a tooltip. */
export const shortEntityId = (id: string | null | undefined): string => (id && UUID.test(id) ? shortId(id) : "");

/** "2031-03-10 14:30" (South African time), the form the viewer and the CSV use. */
export const auditTime = (at: string): string => `${sastDate(at)} ${sastTime(at)}`;
