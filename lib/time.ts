// South African Standard Time helpers. Africa/Johannesburg is UTC+2 with no DST (same assumption as lib/booking/slots.ts),
// so everything is plain arithmetic on a shifted Date: no Intl/ICU dependency, identical on server, client and in tests.
export const SAST_MS = 2 * 3600_000;
const DAY_MS = 24 * 3600_000;
export const BOOKING_HORIZON_DAYS = 60;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const shifted = (d: Date) => new Date(d.getTime() + SAST_MS);

/** Calendar date (YYYY-MM-DD) of an instant in SAST. */
export const sastDate = (d: Date | string): string => shifted(typeof d === "string" ? new Date(d) : d).toISOString().slice(0, 10);

/** "HH:MM" of an instant in SAST. */
export const sastTime = (d: Date | string): string => shifted(typeof d === "string" ? new Date(d) : d).toISOString().slice(11, 16);

/** "Monday, 6 January 2031" for a YYYY-MM-DD date, or for an instant (read in SAST). */
export function sastDateLabel(d: Date | string): string {
  const s = shifted(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : typeof d === "string" ? new Date(d) : d);
  // for a plain date the shift above moved it to 02:00 on the same day, so the date part is unchanged either way
  return `${WEEKDAYS[s.getUTCDay()]}, ${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]} ${s.getUTCFullYear()}`;
}

/** Add whole days to a YYYY-MM-DD date. */
export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** True for a real calendar date in strict YYYY-MM-DD form. */
export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

/** Bookable date range for the public journey: from tomorrow up to 60 days ahead (inclusive), in SAST. */
export function bookingDateRange(now: Date): { min: string; max: string } {
  const today = sastDate(now);
  return { min: addDays(today, 1), max: addDays(today, BOOKING_HORIZON_DAYS) };
}

export function isBookableDate(date: string, now: Date): boolean {
  if (!isRealDate(date)) return false;
  const { min, max } = bookingDateRange(now);
  return date >= min && date <= max;
}

/** UTC instants [from, to) covering the SAST day of `date` plus one day either side (for busy ranges and buffers). */
export function dayWindowUtc(date: string): { from: string; to: string } {
  const start = Date.parse(`${date}T00:00:00Z`) - SAST_MS;
  return { from: new Date(start - DAY_MS).toISOString(), to: new Date(start + 2 * DAY_MS).toISOString() };
}
