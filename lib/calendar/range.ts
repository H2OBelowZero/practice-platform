import { addDays, isRealDate, sastDate, sastDateLabel, sastDayShort, sastMidnight } from "@/lib/time";

export type CalView = "day" | "week" | "agenda";
export const AGENDA_DAYS = 14;

export const parseView = (v: string | undefined): CalView => (v === "day" || v === "week" || v === "agenda" ? v : "week");

/** Date from the URL, or today (SAST) when absent or malformed. */
export const parseDate = (d: string | undefined, now: Date): string => (d !== undefined && isRealDate(d) ? d : sastDate(now));

/** Monday of the week containing `date` (weeks run Monday to Sunday). */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** Inclusive date range shown by a view, and the list of its days. */
export function viewRange(view: CalView, date: string): { first: string; last: string; days: string[] } {
  const first = view === "week" ? weekStart(date) : date;
  const n = view === "day" ? 1 : view === "week" ? 7 : AGENDA_DAYS;
  const days = Array.from({ length: n }, (_, i) => addDays(first, i));
  return { first, last: days[n - 1], days };
}

/** The date to show after pressing previous (-1) or next (+1): a day, a week, or a fortnight. */
export const stepDate = (view: CalView, date: string, dir: 1 | -1): string =>
  addDays(view === "week" ? weekStart(date) : date, dir * (view === "day" ? 1 : view === "week" ? 7 : AGENDA_DAYS));

/** UTC instants [from, to) covering the SAST days first..last inclusive. */
export const rangeBoundsUtc = (first: string, last: string): { from: string; to: string } => ({ from: sastMidnight(first), to: sastMidnight(addDays(last, 1)) });

/** Calendar URL that keeps the filters. Empty values are left out. */
export function calendarHref(p: { view: CalView; date: string; status?: string; q?: string }): string {
  const sp = new URLSearchParams({ view: p.view, date: p.date });
  if (p.status) sp.set("status", p.status);
  if (p.q) sp.set("q", p.q);
  return `/app/calendar?${sp.toString()}`;
}

/** Heading for the shown period: a full date for a day, otherwise "Mon 6 Jan 2031 to Sun 12 Jan 2031". */
export const rangeLabel = (view: CalView, first: string, last: string): string =>
  view === "day" ? sastDateLabel(first) : `${sastDayShort(first, true)} to ${sastDayShort(last, true)}`;
