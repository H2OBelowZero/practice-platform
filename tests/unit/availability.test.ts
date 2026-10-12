import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Query, Result } from "../stubs/fake-supabase";
import { called } from "../stubs/fake-supabase";

// getSlots with a fake client that behaves like the database: a session_types query that asks for active = true finds nothing for an inactive type.
const h = vi.hoisted(() => ({ active: false, log: [] as Query[] }));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => (await import("../stubs/fake-supabase")).fakeSupabase((q: Query): Result => {
    if (q.table === "session_types") return { data: !h.active && q.calls.some((c) => c.m === "eq" && c.a[0] === "active") ? null : { duration_min: 50, buffer_min: 10 } };
    if (q.table === "availability_rules") return { data: [{ weekday: 1, start_time: "08:00:00", end_time: "12:00:00" }] };
    if (q.table === "rpc:busy_ranges") return { data: [] };
    return {};
  }, h.log),
}));

import { getSlots } from "@/lib/booking/availability";

const TYPE = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d";
const MONDAY = "2031-03-10";
beforeEach(() => { h.active = false; h.log.length = 0; });

describe("getSlots and inactive session types", () => {
  it("offers nothing for an inactive type by default (new bookings), and asks the database for active types only", async () => {
    expect(await getSlots(TYPE, MONDAY)).toEqual([]);
    expect(called(h.log.find((q) => q.table === "session_types")!, "eq", "active", true)).toBe(true);
  });
  it("offers the normal slots for an inactive type when asked for an EXISTING appointment's own type (reschedule)", async () => {
    const slots = await getSlots(TYPE, MONDAY, { includeInactive: true });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]).toBe("2031-03-10T06:00:00.000Z"); // 08:00 SAST
    expect(h.log.find((q) => q.table === "session_types")!.calls.some((c) => c.m === "eq" && c.a[0] === "active")).toBe(false);
  });
  it("an active type gives the same slots either way", async () => {
    h.active = true;
    expect(await getSlots(TYPE, MONDAY, { includeInactive: true })).toEqual(await getSlots(TYPE, MONDAY));
  });
  it("the option is explicit: anything but includeInactive: true keeps the filter", async () => {
    expect(await getSlots(TYPE, MONDAY, {})).toEqual([]);
    expect(await getSlots(TYPE, MONDAY, { includeInactive: false })).toEqual([]);
  });
});
