// Working hours helpers (pure). The database stores one row per window with weekday = extract(dow): 0 = Sunday. People read the week Monday first.
export type Win = { start: string; end: string };

export const STEP_MIN = 5;
export const MAX_WINDOWS = 8; // same ceiling as set_day_availability (0027)

/** The week as people read it (Monday first), with the database weekday number (0 = Sunday) beside each name. */
export const WEEK: readonly { weekday: number; label: string }[] = [
  { weekday: 1, label: "Monday" }, { weekday: 2, label: "Tuesday" }, { weekday: 3, label: "Wednesday" }, { weekday: 4, label: "Thursday" },
  { weekday: 5, label: "Friday" }, { weekday: 6, label: "Saturday" }, { weekday: 0, label: "Sunday" },
];
export const WEEKDAYS_MON_FRI = [1, 2, 3, 4, 5] as const;
export const weekdayLabel = (weekday: number): string => WEEK.find((d) => d.weekday === weekday)?.label ?? "";
export const isWeekday = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 6;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "08:30" -> 510 minutes after midnight, or null when it is not a clean HH:MM (24-hour, two digits each). */
export function parseHHMM(s: string): number | null {
  const m = HHMM.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
export const formatHHMM = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** The text after the first problem found in one window, or null when it is fine (real times, 5-minute steps, the end after the start). */
export function windowProblem(w: Win): string | null {
  const a = parseHHMM(w.start), b = parseHHMM(w.end);
  if (a === null || b === null) return "Enter both times, for example 08:00 and 12:30.";
  if (a % STEP_MIN !== 0 || b % STEP_MIN !== 0) return "Use 5-minute steps, for example 08:00 or 08:05.";
  if (b <= a) return "A window must end after it starts.";
  return null;
}

/** The first pair of windows that overlap (touching, 08:00-12:00 and 12:00-17:00, is fine), as indexes into the list, or null. */
export function findOverlap(ws: Win[]): [number, number] | null {
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      const a = parseHHMM(ws[i].start), b = parseHHMM(ws[i].end), c = parseHHMM(ws[j].start), d = parseHHMM(ws[j].end);
      if (a !== null && b !== null && c !== null && d !== null && a < d && c < b) return [i, j];
    }
  }
  return null;
}

export const sortWindows = (ws: Win[]): Win[] => [...ws].sort((x, y) => (parseHHMM(x.start) ?? 0) - (parseHHMM(y.start) ?? 0));

/** A whole day's list: each window valid, at most MAX_WINDOWS, none overlapping. Returns the windows sorted, or the message and the offending row (0-based). */
export function validateDay(ws: Win[]): { ok: true; windows: Win[] } | { ok: false; error: string; index?: number } {
  if (ws.length > MAX_WINDOWS) return { ok: false, error: `Use at most ${MAX_WINDOWS} windows in one day.` };
  for (let i = 0; i < ws.length; i++) {
    const p = windowProblem(ws[i]);
    if (p) return { ok: false, error: p, index: i };
  }
  const o = findOverlap(ws);
  if (o) return { ok: false, error: "Two windows overlap. Make one end before the other starts.", index: o[1] };
  return { ok: true, windows: sortWindows(ws) };
}

/** Database time ("08:00:00") to the HH:MM a person edits. */
export const trimTime = (t: string): string => t.slice(0, 5);

/** Rows of availability_rules into windows per database weekday, each day sorted. */
export function windowsByWeekday(rows: { weekday: number; start_time: string; end_time: string }[]): Record<number, Win[]> {
  const out: Record<number, Win[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const r of rows) if (isWeekday(r.weekday)) out[r.weekday].push({ start: trimTime(r.start_time), end: trimTime(r.end_time) });
  for (const d of Object.keys(out)) out[Number(d)] = sortWindows(out[Number(d)]);
  return out;
}

/** "Copy Monday to the weekdays": the same windows for every target day (copies, so editing one list never changes another). */
export function copyDay(source: Win[], targets: readonly number[]): Record<number, Win[]> {
  return Object.fromEntries(targets.map((d) => [d, source.map((w) => ({ ...w }))]));
}

/** Total open minutes in a day (for a short summary). */
export const dayMinutes = (ws: Win[]): number => ws.reduce((n, w) => n + Math.max(0, (parseHHMM(w.end) ?? 0) - (parseHHMM(w.start) ?? 0)), 0);

/** "08:00 to 12:00, 13:00 to 17:00" or "Closed". */
export const describeDay = (ws: Win[]): string => (ws.length ? ws.map((w) => `${w.start} to ${w.end}`).join(", ") : "Closed");

/** The form fields start_0 / end_0 / start_1 ... of a day form, in order, until the first index with neither field. */
export function windowsFromValues(values: Record<string, string>): Win[] {
  const out: Win[] = [];
  for (let i = 0; i < 40; i++) {
    const s = values[`start_${i}`], e = values[`end_${i}`];
    if (s === undefined && e === undefined) continue; // a removed row leaves a gap in the numbering
    out.push({ start: (s ?? "").trim(), end: (e ?? "").trim() });
  }
  return out;
}
