import { SAST_MS, sastDate } from "@/lib/time";

const DAY_MIN = 1440;
const MIN_BLOCK_MIN = 20; // very short appointments still get a block you can see and click

/** Minutes since SAST midnight of `date` for an instant, clamped to 0..1440 (an instant outside the day sticks to its edge). */
export function minuteOfDay(iso: string, date: string): number {
  const m = (Date.parse(iso) - (Date.parse(`${date}T00:00:00Z`) - SAST_MS)) / 60_000;
  return Math.min(DAY_MIN, Math.max(0, m));
}

/** Appointments that overlap the SAST day `date` (an appointment crossing midnight shows on both days, clipped). */
export function overlapsDay<T extends { starts_at: string; ends_at: string }>(items: T[], date: string): T[] {
  const dayStart = Date.parse(`${date}T00:00:00Z`) - SAST_MS, dayEnd = dayStart + DAY_MIN * 60_000;
  return items.filter((a) => Date.parse(a.starts_at) < dayEnd && Date.parse(a.ends_at) > dayStart);
}

/** Agenda grouping: one entry per day (in order, empty days kept) with the appointments that START on it, sorted by time. */
export function groupByDay<T extends { starts_at: string }>(items: T[], days: string[]): { date: string; items: T[] }[] {
  return days.map((date) => ({
    date,
    items: items.filter((a) => sastDate(a.starts_at) === date).sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)),
  }));
}

/** Vertical position of a block as percentages of the grid height. Clamped to the grid; never shorter than MIN_BLOCK_MIN. */
export function blockPosition(startMin: number, endMin: number, gridStartMin: number, gridEndMin: number): { top: number; height: number } {
  const span = gridEndMin - gridStartMin;
  const s = Math.min(gridEndMin, Math.max(gridStartMin, startMin));
  const e = Math.min(gridEndMin, Math.max(endMin, s + MIN_BLOCK_MIN));
  return { top: ((s - gridStartMin) / span) * 100, height: ((e - s) / span) * 100 };
}

/**
 * Side-by-side lanes for overlapping blocks. Blocks that overlap (directly or through a chain) share a cluster; each gets the
 * first free lane, and `lanes` is the number of lanes in its cluster so all share the width evenly.
 * Touching blocks (one ends when the next starts) do not overlap.
 */
export function assignLanes<T extends { startMin: number; endMin: number }>(items: T[]): (T & { lane: number; lanes: number })[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: (T & { lane: number; lanes: number })[] = [];
  let cluster: (T & { lane: number; lanes: number })[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => { for (const c of cluster) c.lanes = laneEnds.length; out.push(...cluster); cluster = []; laneEnds = []; };
  for (const it of sorted) {
    if (it.startMin >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= it.startMin);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.endMin); } else laneEnds[lane] = it.endMin;
    cluster.push({ ...it, lane, lanes: 0 });
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  flush();
  return out;
}

/** Whole-hour range of the time grid: the working hours from availability rules, widened to include any appointment outside them. */
export function gridHours(rules: { start: string; end: string }[], blocks: { startMin: number; endMin: number }[]): { startHour: number; endHour: number } {
  const hm = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const starts = [...rules.map((r) => hm(r.start)), ...blocks.map((b) => b.startMin)];
  const ends = [...rules.map((r) => hm(r.end)), ...blocks.map((b) => b.endMin)];
  if (starts.length === 0) return { startHour: 8, endHour: 17 };
  const startHour = Math.floor(Math.min(...starts) / 60);
  const endHour = Math.min(24, Math.max(startHour + 1, Math.ceil(Math.max(...ends) / 60)));
  return { startHour, endHour };
}
