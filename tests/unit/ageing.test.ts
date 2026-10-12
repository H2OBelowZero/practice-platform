import { it, expect } from "vitest";
import { ageingBucket, ageingSummary, AGEING_BUCKETS } from "@/lib/reports/ageing";

it("buckets by days overdue", () => {
  expect(ageingBucket("2030-02-10", "2030-02-01")).toBe("current");
  expect(ageingBucket("2030-02-01", "2030-02-01")).toBe("current"); // due today is not overdue
  expect(ageingBucket("2030-01-31", "2030-02-01")).toBe("1-30");
  expect(ageingBucket("2030-01-20", "2030-02-01")).toBe("1-30");
  expect(ageingBucket("2029-12-31", "2030-01-30")).toBe("1-30"); // 30 days
  expect(ageingBucket("2029-12-30", "2030-01-30")).toBe("31-60"); // 31 days
  expect(ageingBucket("2029-12-01", "2030-02-01")).toBe("61-90");
  expect(ageingBucket("2029-11-02", "2030-02-01")).toBe("90+"); // 91 days
  expect(ageingBucket("2029-10-01", "2030-02-01")).toBe("90+");
});

it("sums open balances per bucket in integer cents, every bucket present", () => {
  const s = ageingSummary([
    { dueDate: "2030-02-10", n: 1, outstandingCents: 10000 },
    { dueDate: "2030-02-20", n: 2, outstandingCents: 5050 },
    { dueDate: "2030-01-20", n: 3, outstandingCents: 30000 },
    { dueDate: "2029-10-01", n: 1, outstandingCents: 99 },
  ], "2030-02-01");
  expect(Object.keys(s)).toEqual([...AGEING_BUCKETS]);
  expect(s.current).toEqual({ n: 3, outstandingCents: 15050 });
  expect(s["1-30"]).toEqual({ n: 3, outstandingCents: 30000 });
  expect(s["31-60"]).toEqual({ n: 0, outstandingCents: 0 });
  expect(s["90+"]).toEqual({ n: 1, outstandingCents: 99 });
  expect(ageingSummary([], "2030-02-01")["61-90"]).toEqual({ n: 0, outstandingCents: 0 });
});
