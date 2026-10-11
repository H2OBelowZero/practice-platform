const SAST_MS = 2 * 3600_000; // Africa/Johannesburg has no DST
export type Rule = { weekday: number; start: string; end: string };
export type Range = { start: string; end: string };
const mins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

// strict format plus a real-calendar check (rejects 2030-02-30, 2030-13-40)
function assertDate(date: string) {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error("invalid_date");
}

export function generateSlots(o: { date: string; rules: Rule[]; busy: Range[]; durationMin: number; bufferMin: number; now: Date }): string[] {
  assertDate(o.date);
  if (!(o.durationMin + o.bufferMin > 0)) return []; // a zero/negative step would loop forever (also guards NaN)
  const dayStart = Date.parse(`${o.date}T00:00:00Z`) - SAST_MS;       // local midnight as an instant
  const weekday = new Date(dayStart + SAST_MS).getUTCDay();
  const step = (o.durationMin + o.bufferMin) * 60_000, dur = o.durationMin * 60_000, buf = o.bufferMin * 60_000;
  const busy = o.busy.map(b => [Date.parse(b.start) - buf, Date.parse(b.end) + buf] as const);
  const out: string[] = [];
  for (const r of o.rules.filter(r => r.weekday === weekday)) {
    const end = dayStart + mins(r.end) * 60_000;
    for (let t = dayStart + mins(r.start) * 60_000; t + dur <= end; t += step) {
      if (t <= o.now.getTime()) continue;
      if (busy.some(([a, b]) => t < b && t + dur > a)) continue;
      out.push(new Date(t).toISOString());
    }
  }
  return [...new Set(out)].sort();
}
