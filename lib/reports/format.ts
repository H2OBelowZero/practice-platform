const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A fraction as a percentage with one decimal: 0.1234 -> "12.3%". null (nothing to divide by) -> "n/a". */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return "n/a";
  return `${(Math.round(fraction * 1000) / 10).toFixed(1)}%`;
}

/** The same figure as a number for a CSV cell (percent, one decimal): 0.1234 -> 12.3; null stays null. */
export const percentNumber = (fraction: number | null | undefined): number | null =>
  fraction === null || fraction === undefined || !Number.isFinite(fraction) ? null : Math.round(fraction * 1000) / 10;

/** "Jan 2030" for "2030-01-01" or "2030-01". Anything else is returned unchanged. */
export function monthLabel(value: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(value);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value;
}

/** Width in whole percent (0 to 100) of an in-table bar. Zero or less stays 0; any positive value shows at least 1 so it is not invisible. */
export function barWidth(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || value <= 0 || max <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round((value / max) * 100)));
}

/** Cents as a plain number of rand for a CSV cell: 123450 -> 1234.5, -115 -> -1.15. Exact: cents/100 prints the shortest round-tripping decimal. */
export const zar = (cents: number | null | undefined): number | null => (cents === null || cents === undefined ? null : cents / 100);

/** Minutes as "12 h 30 min" (or "45 min", "0 min"). */
export function minutesText(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}
