import { it, expect, describe } from "vitest";
import { cancellationOutcome } from "@/lib/booking/policy";

it("late cancellations incur the fee", () => {
  const o = cancellationOutcome({ startsAt: new Date("2030-01-07T08:00:00Z"), now: new Date("2030-01-07T00:00:00Z"), windowHours: 24, lateFeeCents: 50000 });
  expect(o).toEqual({ allowed: true, late: true, feeCents: 50000 });
});

it("early cancellations are free", () => {
  const o = cancellationOutcome({ startsAt: new Date("2030-01-09T08:00:00Z"), now: new Date("2030-01-07T00:00:00Z"), windowHours: 24, lateFeeCents: 50000 });
  expect(o.feeCents).toBe(0);
});

describe("window boundary", () => {
  const now = new Date("2030-01-07T00:00:00Z");
  const startsAt = new Date("2030-01-08T00:00:00Z"); // exactly 24h away

  it("exactly at the window boundary is not late", () => {
    expect(cancellationOutcome({ startsAt, now, windowHours: 24, lateFeeCents: 50000 })).toEqual({ allowed: true, late: false, feeCents: 0 });
  });

  it("one millisecond inside the window is late", () => {
    const o = cancellationOutcome({ startsAt: new Date(startsAt.getTime() - 1), now, windowHours: 24, lateFeeCents: 50000 });
    expect(o).toEqual({ allowed: true, late: true, feeCents: 50000 });
  });
});

describe("already started", () => {
  it("an appointment that has started is late", () => {
    const now = new Date("2030-01-07T08:00:00Z");
    expect(cancellationOutcome({ startsAt: now, now, windowHours: 24, lateFeeCents: 50000 }).late).toBe(true);
    expect(cancellationOutcome({ startsAt: new Date("2030-01-07T07:00:00Z"), now, windowHours: 24, lateFeeCents: 50000 }).late).toBe(true);
  });

  it("windowHours 0 means never late, except when already started", () => {
    const now = new Date("2030-01-07T00:00:00Z");
    expect(cancellationOutcome({ startsAt: new Date("2030-01-07T01:00:00Z"), now, windowHours: 0, lateFeeCents: 50000 }).late).toBe(false);
    expect(cancellationOutcome({ startsAt: now, now, windowHours: 0, lateFeeCents: 50000 }).late).toBe(true);
  });

  it("a zero late fee stays zero", () => {
    const o = cancellationOutcome({ startsAt: new Date("2030-01-07T01:00:00Z"), now: new Date("2030-01-07T00:00:00Z"), windowHours: 24, lateFeeCents: 0 });
    expect(o).toEqual({ allowed: true, late: true, feeCents: 0 });
  });
});
