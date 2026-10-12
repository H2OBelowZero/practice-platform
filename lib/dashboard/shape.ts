import { statusMeta } from "@/lib/status";
import { addDays, sastDate, sastDateLabel, sastDayShort, sastMidnight, SAST_MS } from "@/lib/time";

/** Whole hour (0 to 23) of an instant in South African time. */
export const sastHour = (now: Date): number => new Date(now.getTime() + SAST_MS).getUTCHours();

/** "Good morning" until 11:59, "Good afternoon" from 12:00 to 17:59, "Good evening" from 18:00 (SAST). */
export function greeting(now: Date): string {
  const h = sastHour(now);
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** [from, to) in UTC of one SAST calendar day. */
export const dayBoundsUtc = (date: string): { from: string; to: string } => ({ from: sastMidnight(date), to: sastMidnight(addDays(date, 1)) });

/** The first day of the month `today` falls in (YYYY-MM-01). */
export const monthStart = (today: string): string => `${today.slice(0, 7)}-01`;

/** "3 sessions", "1 session", "No sessions". */
export const countText = (n: number, one: string, many: string): string => (n === 0 ? `No ${many}` : `${n} ${n === 1 ? one : many}`);

/** A count for a tile: the number, or an en dash when the query failed. */
export const tileCount = (n: number | null | undefined): string => (n === null || n === undefined ? "–" : String(n));

export type Dated = { starts_at: string };
export type DayGroup<T> = { date: string; label: string; items: T[] };

/** Appointments (already in time order) grouped by SAST day, in day order; at most `max` items overall. */
export function groupByDay<T extends Dated>(items: T[], max = 20): DayGroup<T>[] {
  const out: DayGroup<T>[] = [];
  for (const it of items.slice(0, max)) {
    const date = sastDate(it.starts_at);
    const last = out[out.length - 1];
    if (last && last.date === date) last.items.push(it);
    else out.push({ date, label: sastDayShort(date), items: [it] });
  }
  return out;
}

/** The window "next 7 days": tomorrow's start up to the start of today + 8 (so 7 whole days after today). */
export const upcomingBoundsUtc = (today: string): { from: string; to: string } => ({ from: sastMidnight(addDays(today, 1)), to: sastMidnight(addDays(today, 8)) });

/** How many appointments are in each status, in a fixed order (confirmed, requested, attended, no-show), with the status label. */
const MIX_ORDER = ["confirmed", "tentative", "attended", "no_show", "cancelled"];
export function statusMix(items: { status: string }[]): { status: string; label: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
  const keys = [...counts.keys()].sort((a, b) => (MIX_ORDER.indexOf(a) + 1 || 99) - (MIX_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return keys.map((k) => ({ status: k, label: statusMeta(k).label.toLowerCase(), n: counts.get(k)! }));
}

/** "2 confirmed, 1 requested" or "" for nothing. */
export const statusMixText = (items: { status: string }[]): string => statusMix(items).map((m) => `${m.n} ${m.label}`).join(", ");

/** The minutes between two instants, rounded; never negative. */
export const minutesBetween = (start: string, end: string): number => Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));

/** One section's data or "could not load": a failed query never takes the page down. */
export type Section<T> = { ok: true; data: T } | { ok: false };

/** Run a loader; a thrown error or a rejected promise becomes { ok: false } (details are logged as a code only, never shown). */
export async function section<T>(name: string, fn: () => Promise<T>): Promise<Section<T>> {
  try { return { ok: true, data: await fn() }; } catch (e) {
    console.error(`dashboard ${name} failed:`, e instanceof Error ? e.message : "unknown");
    return { ok: false };
  }
}

/** Turn a Supabase result into its data, or throw (so `section` can catch it). Error text is dropped here: it may name a column or a value. */
export function must<T>(r: { data: T | null; error: { code?: string } | null; count?: number | null }): { data: T; count: number | null } {
  if (r.error) throw new Error(`query_failed:${r.error.code ?? ""}`);
  return { data: (r.data ?? ([] as unknown as T)), count: r.count ?? null };
}

/** "October 2026" for a YYYY-MM-DD date. */
export const monthLabel = (date: string): string => sastDateLabel(date).split(" ").slice(-2).join(" ");
