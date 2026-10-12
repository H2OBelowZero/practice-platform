import { addDays, isRealDate } from "@/lib/time";

// Report periods are South African calendar dates (YYYY-MM-DD). `today` is always passed in (sastDate(new Date())), so everything here is pure.

export const PRESETS = ["this_month", "last_month", "last_3_months", "this_year", "custom"] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_LABEL: Record<Preset, string> = {
  this_month: "This month", last_month: "Last month", last_3_months: "Last 3 months", this_year: "This year", custom: "Custom dates",
};
export const DEFAULT_PRESET: Preset = "last_3_months";
/** The database refuses a report longer than this many days from first to last date (0025). */
export const MAX_SPAN_DAYS = 800;

export type DateRange = { from: string; to: string };

const firstOfMonth = (d: string) => `${d.slice(0, 7)}-01`;

/** The first day of the month `n` months from the month of `date` (n may be negative). */
export function addMonths(date: string, n: number): string {
  const idx = Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}-01`;
}

/**
 * The dates a preset stands for, as of `today` (SAST):
 *   this month = the 1st to today; last month = the whole previous calendar month (leap days included);
 *   last 3 months = the 1st of the month two months back (so this month and the two before it) to today; this year = 1 January to today.
 */
export function presetRange(preset: Exclude<Preset, "custom">, today: string): DateRange {
  const month = firstOfMonth(today);
  switch (preset) {
    case "this_month": return { from: month, to: today };
    case "last_month": return { from: addMonths(month, -1), to: addDays(month, -1) };
    case "last_3_months": return { from: addMonths(month, -2), to: today };
    case "this_year": return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/** Why a from/to pair cannot be used, in plain words, or null when it can. */
export function rangeProblem(from: string, to: string): string | null {
  if (!isRealDate(from) || !isRealDate(to)) return "Please enter both dates as real calendar dates.";
  if (from < "2000-01-01" || to > "2100-12-31") return "Please choose dates between the years 2000 and 2100.";
  if (from > to) return "The start date cannot be after the end date.";
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > MAX_SPAN_DAYS) return `Please choose a period of at most ${MAX_SPAN_DAYS} days (about two years).`;
  return null;
}

export type Period = DateRange & { preset: Preset; problem: string | null };

/**
 * The period for a request. `preset` wins when it is a known preset other than custom (from and to are then ignored). `custom`, or from/to without any preset,
 * uses the typed dates and must pass rangeProblem; anything unusable falls back to the default preset and says why in `problem`. Nothing here trusts the URL.
 */
export function parsePeriod(sp: { preset?: string; from?: string; to?: string }, today: string): Period {
  const dflt = { preset: DEFAULT_PRESET, ...presetRange("last_3_months", today) };
  const named = PRESETS.find((p) => p === sp.preset);
  if (named && named !== "custom") return { preset: named, ...presetRange(named, today), problem: null };
  if (!named && sp.preset !== undefined && sp.preset !== "") return { ...dflt, problem: null }; // an unknown preset word is just ignored
  if (!named && sp.from === undefined && sp.to === undefined) return { ...dflt, problem: null };
  const from = sp.from ?? "", to = sp.to ?? "";
  const problem = rangeProblem(from, to);
  return problem ? { ...dflt, problem } : { preset: "custom", from, to, problem: null };
}

/** "5 Jan 2030 to 31 Mar 2030" style text for a range heading. */
export function rangeText(r: DateRange): string {
  const f = (d: string) => `${Number(d.slice(8, 10))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
  return r.from === r.to ? f(r.from) : `${f(r.from)} to ${f(r.to)}`;
}

/** The debtors report is "as at" a day that cannot be in the future: the end of the period, or today when the period runs past today. */
export const debtorsAsOf = (to: string, today: string): string => (to < today ? to : today);
