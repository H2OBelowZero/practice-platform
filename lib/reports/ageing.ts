export const AGEING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

export const AGEING_LABEL: Record<AgeingBucket, string> = {
  current: "Not yet due", "1-30": "1 to 30 days overdue", "31-60": "31 to 60 days overdue", "61-90": "61 to 90 days overdue", "90+": "Over 90 days overdue",
};

/** Whole days between two YYYY-MM-DD dates are put in a bucket by how long past due: due today or later is "current". */
export function ageingBucket(due: string, today: string): AgeingBucket {
  const d = Math.floor((Date.parse(today) - Date.parse(due)) / 86400000);
  return d <= 0 ? "current" : d <= 30 ? "1-30" : d <= 60 ? "31-60" : d <= 90 ? "61-90" : "90+";
}

/** Open balances (one row per due date, from billing_open_by_due_date) summed per bucket. Integer cents; every bucket is present. */
export function ageingSummary(rows: { dueDate: string; n: number; outstandingCents: number }[], today: string): Record<AgeingBucket, { n: number; outstandingCents: number }> {
  const out = Object.fromEntries(AGEING_BUCKETS.map((b) => [b, { n: 0, outstandingCents: 0 }])) as Record<AgeingBucket, { n: number; outstandingCents: number }>;
  for (const r of rows) { const b = out[ageingBucket(r.dueDate, today)]; b.n += r.n; b.outstandingCents += r.outstandingCents; }
  return out;
}
