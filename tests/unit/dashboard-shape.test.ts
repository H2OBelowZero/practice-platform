import { describe, it, expect, vi } from "vitest";
import { countText, dayBoundsUtc, greeting, groupByDay, minutesBetween, monthLabel, monthStart, must, section, statusMix, statusMixText, tileCount, upcomingBoundsUtc, sastHour } from "@/lib/dashboard/shape";

// SAST = UTC+2, no DST. 2031-03-10T10:00:00Z is 12:00 SAST.
const at = (iso: string) => new Date(iso);

describe("greeting (SAST)", () => {
  it("morning until 11:59, afternoon 12:00 to 17:59, evening from 18:00", () => {
    expect(greeting(at("2031-03-10T00:00:00Z"))).toBe("Good morning"); // 02:00 SAST
    expect(greeting(at("2031-03-10T09:59:00Z"))).toBe("Good morning"); // 11:59
    expect(greeting(at("2031-03-10T10:00:00Z"))).toBe("Good afternoon"); // 12:00
    expect(greeting(at("2031-03-10T15:59:00Z"))).toBe("Good afternoon"); // 17:59
    expect(greeting(at("2031-03-10T16:00:00Z"))).toBe("Good evening"); // 18:00
    expect(greeting(at("2031-03-10T21:59:00Z"))).toBe("Good evening"); // 23:59
  });
  it("uses South African time, not the server's: 22:00 UTC is already the next morning", () => {
    expect(sastHour(at("2031-03-10T22:00:00Z"))).toBe(0);
    expect(greeting(at("2031-03-10T22:00:00Z"))).toBe("Good morning");
    expect(greeting(at("2031-03-10T21:59:59Z"))).toBe("Good evening");
  });
});

describe("SAST day and month boundaries", () => {
  it("a SAST day runs from 22:00Z the day before to 22:00Z", () => {
    expect(dayBoundsUtc("2031-03-10")).toEqual({ from: "2031-03-09T22:00:00.000Z", to: "2031-03-10T22:00:00.000Z" });
    expect(dayBoundsUtc("2031-12-31")).toEqual({ from: "2031-12-30T22:00:00.000Z", to: "2031-12-31T22:00:00.000Z" });
  });
  it("the upcoming window is the 7 days after today", () => {
    expect(upcomingBoundsUtc("2031-03-10")).toEqual({ from: "2031-03-10T22:00:00.000Z", to: "2031-03-17T22:00:00.000Z" });
    expect(upcomingBoundsUtc("2031-02-25").to).toBe("2031-03-04T22:00:00.000Z"); // across the month end
  });
  it("month start and label", () => {
    expect(monthStart("2031-03-10")).toBe("2031-03-01");
    expect(monthStart("2031-12-31")).toBe("2031-12-01");
    expect(monthLabel("2031-03-10")).toBe("March 2031");
  });
});

describe("grouping and counts", () => {
  const a = (id: string, iso: string) => ({ id, starts_at: iso });
  it("groups appointments by SAST day in order; a 23:30 SAST session belongs to its own day", () => {
    const g = groupByDay([a("1", "2031-03-11T06:00:00Z"), a("2", "2031-03-11T08:00:00Z"), a("3", "2031-03-11T21:30:00Z"), a("4", "2031-03-12T07:00:00Z")]);
    expect(g.map((x) => [x.date, x.items.map((i) => i.id)])).toEqual([["2031-03-11", ["1", "2", "3"]], ["2031-03-12", ["4"]]]);
    expect(g[0].label).toBe("Tue 11 Mar");
  });
  it("keeps at most max items overall and copes with none", () => {
    const many = Array.from({ length: 30 }, (_, i) => a(String(i), `2031-03-11T${String(6 + Math.floor(i / 4)).padStart(2, "0")}:00:00Z`));
    expect(groupByDay(many, 20).reduce((n, g) => n + g.items.length, 0)).toBe(20);
    expect(groupByDay([])).toEqual([]);
  });
  it("status mix is in a fixed order with readable labels", () => {
    const rows = [{ status: "attended" }, { status: "confirmed" }, { status: "tentative" }, { status: "confirmed" }, { status: "no_show" }];
    expect(statusMix(rows).map((m) => [m.label, m.n])).toEqual([["confirmed", 2], ["requested", 1], ["attended", 1], ["no-show", 1]]);
    expect(statusMixText(rows)).toBe("2 confirmed, 1 requested, 1 attended, 1 no-show");
    expect(statusMixText([])).toBe("");
    expect(statusMixText([{ status: "something_new" }])).toBe("1 something new");
  });
  it("counts read naturally, and a missing count is a dash", () => {
    expect(countText(0, "session", "sessions")).toBe("No sessions");
    expect(countText(1, "session", "sessions")).toBe("1 session");
    expect(countText(12, "session", "sessions")).toBe("12 sessions");
    expect(tileCount(0)).toBe("0");
    expect(tileCount(7)).toBe("7");
    expect(tileCount(null)).toBe("–");
    expect(tileCount(undefined)).toBe("–");
  });
  it("minutes between two instants", () => {
    expect(minutesBetween("2031-03-10T08:00:00Z", "2031-03-10T08:50:00Z")).toBe(50);
    expect(minutesBetween("2031-03-10T08:00:00Z", "2031-03-10T07:00:00Z")).toBe(0);
  });
});

describe("section / must: a failing query never breaks the page", () => {
  it("returns the data when the loader works", async () => {
    expect(await section("x", async () => 5)).toEqual({ ok: true, data: 5 });
  });
  it("turns a thrown error into { ok: false } and logs a code only (never the message of a database error)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await section("tasks", async () => { must({ data: null, error: { code: "42P01" } }); })).toEqual({ ok: false });
    expect(log).toHaveBeenCalledWith("dashboard tasks failed:", "query_failed:42P01");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/relation|column|secret/);
    log.mockRestore();
  });
  it("must returns an empty list for null data and keeps the count", () => {
    expect(must({ data: null, error: null, count: 4 })).toEqual({ data: [], count: 4 });
    expect(must({ data: [1], error: null })).toEqual({ data: [1], count: null });
  });
});
