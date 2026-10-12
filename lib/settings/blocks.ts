import { isRealDate, sastInstant } from "@/lib/time";

// Blocked time and leave (pure). Staff type SAST wall-clock times in two datetime-local boxes ("2031-05-01T08:00"); the database stores instants.
export const MAX_BLOCK_DAYS = 366;
export const REASON_MAX = 200;

/** "2031-05-01T08:00" (a datetime-local value, SAST) to the stored instant, or null when it is not a real date and time. */
export function localToInstant(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(v.trim());
  return m && isRealDate(m[1]) ? sastInstant(m[1], m[2]) : null;
}

export type BlockInput = { startsAt: string; endsAt: string };

/** Both boxes into instants, or the sentence to show. The end must be after the start and in the future; one block lasts at most a year. */
export function blockRange(starts: string, ends: string, now: Date): { ok: true; value: BlockInput } | { ok: false; error: string; field: "starts" | "ends" } {
  const a = localToInstant(starts), b = localToInstant(ends);
  if (!a) return { ok: false, error: "Enter the date and time the block starts.", field: "starts" };
  if (!b) return { ok: false, error: "Enter the date and time the block ends.", field: "ends" };
  if (Date.parse(b) <= Date.parse(a)) return { ok: false, error: "The block must end after it starts.", field: "ends" };
  if (Date.parse(b) <= now.getTime()) return { ok: false, error: "The block must end in the future.", field: "ends" };
  if (Date.parse(b) - Date.parse(a) > MAX_BLOCK_DAYS * 86_400_000) return { ok: false, error: "A block can last at most a year. Add a second block for longer leave.", field: "ends" };
  return { ok: true, value: { startsAt: a, endsAt: b } };
}

type Span = { starts_at: string; ends_at: string };

/** How many appointments overlap a block (an appointment that only touches the block's edge does not). */
export function overlapCount(block: Span, appts: Span[]): number {
  const s = Date.parse(block.starts_at), e = Date.parse(block.ends_at);
  return appts.filter((a) => Date.parse(a.starts_at) < e && Date.parse(a.ends_at) > s).length;
}

/** The sentence about appointments inside a block (shown after saving and in the list). */
export const clashText = (n: number): string =>
  n === 0 ? "" : `${n} ${n === 1 ? "appointment falls" : "appointments fall"} inside this time. ${n === 1 ? "It is" : "They are"} not cancelled or moved automatically.`;
