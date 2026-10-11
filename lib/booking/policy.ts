export function cancellationOutcome(o: { startsAt: Date; now: Date; windowHours: number; lateFeeCents: number }) {
  const started = o.startsAt.getTime() <= o.now.getTime();
  const late = started || o.startsAt.getTime() - o.now.getTime() < o.windowHours * 3600_000;
  return { allowed: true as const, late, feeCents: late ? o.lateFeeCents : 0 };
}
