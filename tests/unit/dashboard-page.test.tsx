import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { called, type Query, type Result } from "../stubs/fake-supabase";

// The staff dashboard rendered with a fake "RLS-filtered" client: whatever the resolver returns is what the signed-in user may read.
// 2031-03-10T07:30:00Z is 09:30 SAST on Monday 10 March 2031.
const h = vi.hoisted(() => ({
  role: "psychologist", resolve: (() => ({})) as (q: Query) => Result, log: [] as Query[],
}));
vi.mock("@/lib/auth/session", () => ({
  requireRole: async (allowed: string[]) => { if (!allowed.includes(h.role)) throw new Error("NOT_FOUND"); return { userId: "me", role: h.role }; },
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => (await import("../stubs/fake-supabase")).fakeSupabase((q) => h.resolve(q), h.log) }));
vi.mock("@/lib/practice", () => ({ getPractice: async () => ({ name: "Dr Example Psychology" }) }));

import StaffHome from "@/app/app/page";

const T = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", P = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", I = "11111111-2222-4333-8444-555555555555", A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const appt = (id: string, starts: string, status: string, o: Record<string, unknown> = {}) => ({
  id, patient_id: P, starts_at: starts, ends_at: new Date(Date.parse(starts) + 50 * 60_000).toISOString(), status,
  patients: { first_name: "Thandi", last_name: "Nkosi" }, session_types: { name: "Individual session", format: "in_person" }, ...o,
});
const sel = (q: Query) => String(q.calls.find((c) => c.m === "select")?.a[0] ?? "");

/** a believable full day; each test changes what it needs */
const base = (q: Query): Result => {
  if (q.table === "appointments") {
    if (sel(q).includes("clinical_notes")) return { data: [{ ...appt(A2, "2031-03-03T08:00:00Z", "attended"), clinical_notes: [] }, { ...appt("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "2031-03-04T08:00:00Z", "attended"), clinical_notes: [{ state: "signed" }] }] };
    if (called(q, "neq", "status", "cancelled")) return { data: [appt(A1, "2031-03-10T08:00:00Z", "confirmed"), appt(A2, "2031-03-10T10:00:00Z", "tentative", { patients: { first_name: "Sipho", last_name: "Dlamini" } })] };
    if (called(q, "eq", "status", "tentative")) return { data: [appt(A2, "2031-03-12T08:00:00Z", "tentative", { patients: { first_name: "Sipho", last_name: "Dlamini" } })], count: 1 };
    return { data: [appt(A1, "2031-03-11T06:00:00Z", "confirmed"), appt(A2, "2031-03-11T08:00:00Z", "confirmed"), appt(T, "2031-03-12T08:00:00Z", "tentative")] };
  }
  if (q.table === "patients") return { data: [{ id: P, first_name: "Lerato", last_name: "Mokoena", created_at: "2031-03-08T08:00:00Z" }], count: 1 };
  if (q.table === "form_submissions") return { data: [{ patient_id: P }], count: 2 };
  if (q.table === "tasks") {
    if (called(q, "like", "source", "payfast_unreconciled:%")) return { count: 1 };
    if (called(q, "lt", "due_at")) return { count: 3 };
    return { data: [
      { id: T, title: "Call the medical aid", due_at: "2031-03-09T22:00:00.000Z", priority: "normal", status: "open", source: "manual", patient_id: null, appointment_id: null, meta: null, created_at: "2031-03-01T00:00:00Z" },
      { id: A1, title: "Overdue invoice: follow up", due_at: null, priority: "high", status: "open", source: `overdue_invoice:${I}`, patient_id: P, appointment_id: null, meta: { invoice_id: I }, created_at: "2031-03-02T00:00:00Z" },
    ] };
  }
  if (q.table === "claims") return { count: called(q, "eq", "status", "rejected") ? 2 : 1 };
  if (q.table === "rpc:billing_open_by_due_date") return { data: [{ due_date: "2031-03-01", n: 2, outstanding_cents: 150000 }, { due_date: "2031-03-20", n: "1", outstanding_cents: "95000" }] };
  if (q.table === "rpc:dashboard_payments_by_method") return { data: [{ method: "eft", n: 3, total_cents: 285000 }, { method: "cash", n: 1, total_cents: 95000 }] };
  return {};
};

const render = async () => renderToStaticMarkup(await StaffHome());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-03-10T07:30:00Z"));
  h.role = "psychologist"; h.resolve = base; h.log.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("/app dashboard", () => {
  it("greets by SAST time with the practice name and today's date", async () => {
    const out = await render();
    expect(out).toContain("Good morning");
    expect(out).not.toContain("only visible to the practitioner"); // the hint is for the admin
    expect(out).toContain("Dr Example Psychology · Monday, 10 March 2031");
    vi.setSystemTime(new Date("2031-03-10T14:00:00Z")); // 16:00 SAST
    expect(await render()).toContain("Good afternoon");
    vi.setSystemTime(new Date("2031-03-10T17:00:00Z")); // 19:00 SAST
    expect(await render()).toContain("Good evening");
  });

  it("shows the tiles with real numbers, each linking to the page where the work is done", async () => {
    const out = await render();
    expect(out).toMatch(/Today&#x27;s sessions<span class="sr-only">: <\/span><\/span><span[^>]*>2<\/span>/);
    expect(out).toContain("1 confirmed, 1 requested");
    expect(out).toContain('href="/app/calendar?view=day"');
    // awaiting action = 1 request + 2 forms + 3 tasks due/overdue
    expect(out).toMatch(/Awaiting action<\/p><p[^>]*>6<\/p>/);
    expect(out).toContain('href="/app/calendar?view=agenda&amp;status=tentative"');
    expect(out).toContain(`href="/app/patients/${P}?tab=forms"`);
    expect(out).toContain('href="/app/tasks?due=now"');
    // outstanding: R 1 500,00 + R 950,00 = R 2 450,00; the 2 invoices due before today are overdue
    expect(out).toContain("R 2 450,00");
    expect(out).toContain("3 open invoices; 2 overdue (R 1 500,00)");
    expect(out).toContain('href="/app/billing"');
    // notes to complete (psychologist): 1 attended without a signed note, links to the oldest
    expect(out).toMatch(/Notes to complete<span class="sr-only">: <\/span><\/span><span[^>]*>1<\/span>/);
    expect(out).toContain(`href="/app/patients/${P}/notes/new?appointment=${A2}"`);
    // claims: 2 rejected + 1 stale
    expect(out).toMatch(/Claims needing attention<span class="sr-only">: <\/span><\/span><span[^>]*>3<\/span>/);
    expect(out).toContain("2 rejected, 1 waiting over 30 days");
    expect(out).toContain('href="/app/claims"');
  });

  it("raises a visible notice for unreconciled PayFast payments, with text and an icon", async () => {
    const out = await render();
    expect(out).toContain("Money to reconcile");
    expect(out).toContain("1 PayFast payment was received but could not be matched");
    expect(out).toContain('href="/app/tasks?group=payfast"');
    expect(out).toContain("Needs attention");
  });

  it("lists the schedule, requests, enquiries, upcoming days, tasks and payments", async () => {
    const out = await render();
    expect(out).toContain("Today&#x27;s schedule");
    expect(out).toContain("10:00 · Thandi Nkosi"); // 08:00Z
    expect(out).toContain("Individual session · In person · 50 minutes");
    expect(out).toContain(`href="/app/calendar/${A1}"`);
    expect(out).toContain("Booking requests");
    expect(out).toContain("Sipho Dlamini");
    expect(out).toMatch(/Confirm<span class="sr-only"> request from Sipho Dlamini/);
    expect(out).toContain("New patient enquiries");
    expect(out).toContain("Lerato Mokoena");
    expect(out).toContain("Added Sat 8 Mar 2031");
    expect(out).toContain("Tue 11 Mar");
    expect(out).toContain("Wed 12 Mar");
    expect(out).toContain("Open tasks");
    expect(out).toContain("Call the medical aid");
    expect(out).toContain("Overdue invoice: follow up");
    expect(out).toContain(`href="/app/billing/${I}"`); // taskLink
    expect(out).toContain("High priority");
    expect(out).toContain("Payments received in March 2031");
    expect(out).toContain("EFT");
    expect(out).toContain("R 2 850,00");
    expect(out).toContain("R 3 800,00"); // total
    for (const s of ["New appointment", "New patient", "New invoice", "Open calendar"]) expect(out).toContain(s);
  });

  it("a tentative request whose start time has passed stays in the list and the count, flagged as overdue", async () => {
    h.resolve = (q) => (q.table === "appointments" && called(q, "eq", "status", "tentative") ? { data: [appt(A2, "2031-03-08T08:00:00Z", "tentative"), appt(T, "2031-03-12T08:00:00Z", "tentative")], count: 2 } : base(q));
    const out = await render();
    expect(out).toContain("Overdue: the start time has passed and this still needs a decision");
    expect(out.match(/Overdue: the start time has passed/g)).toHaveLength(1); // only the one in the past
    expect(out).toMatch(/Awaiting action<\/p><p[^>]*>7<\/p>/); // 2 requests + 2 forms + 3 tasks
    const q = h.log.find((x) => x.table === "appointments" && called(x, "eq", "status", "tentative"))!;
    expect(q.calls.some((c) => c.m === "gte")).toBe(false); // no "not started yet" filter
    expect(called(q, "order", "starts_at")).toBe(true);
  });

  it("an admin sees the operational tiles but no notes tile, and the notes are never queried", async () => {
    h.role = "admin";
    const out = await render();
    expect(out).not.toContain("Notes to complete");
    expect(out).toContain("Some forms are only visible to the practitioner.");
    expect(out).toContain("Outstanding invoices");
    expect(out).toContain("Claims needing attention");
    expect(h.log.some((q) => q.calls.some((c) => c.m === "select" && String(c.a[0]).includes("clinical_notes")))).toBe(false);
    expect(h.log.some((q) => q.table === "clinical_notes")).toBe(false);
  });

  it("sends a bookkeeper to billing before reading anything, and gives an associate a 404", async () => {
    h.role = "bookkeeper";
    await expect(render()).rejects.toThrow("REDIRECT:/app/billing");
    expect(h.log).toHaveLength(0);
    h.role = "associate";
    await expect(render()).rejects.toThrow("NOT_FOUND");
    h.role = "patient";
    await expect(render()).rejects.toThrow("NOT_FOUND");
    expect(h.log).toHaveLength(0);
  });

  it("says so plainly when there is nothing to show", async () => {
    h.resolve = (q) => (q.table.startsWith("rpc:") ? { data: [] } : q.table === "tasks" || q.table === "claims" ? { data: [], count: 0 } : { data: [], count: 0 });
    const out = await render();
    expect(out).toContain("No sessions today.");
    expect(out).toContain("No booking requests are waiting.");
    expect(out).toContain("No new enquiries in the last 14 days.");
    expect(out).toContain("No sessions are booked for the 7 days after today.");
    expect(out).toContain("Nothing is waiting on you. No open tasks.");
    expect(out).toContain("No payments have been recorded this month yet.");
    expect(out).toContain("Nothing is owed");
    expect(out).toContain("All sessions have a signed note");
    expect(out).not.toContain("Money to reconcile");
  });

  it("a failing query shows a quiet note in its own place only; no raw error, no code", async () => {
    h.resolve = (q) => (q.table === "tasks" || q.table === "rpc:billing_open_by_due_date" ? { error: { code: "42P01", message: "relation tasks boom secret" } } : base(q));
    const out = await render();
    expect(out).toContain("We couldn&#x27;t load your tasks just now");
    expect(out).toContain("We couldn&#x27;t load this just now.");
    expect(out).toContain("not available</span>"); // the tile name says so for a screen reader
    expect(out).not.toContain("aria-label=\"Outstanding invoices");
    expect(out).not.toContain("boom");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("42P01");
    expect(out).not.toContain("relation");
    // the rest of the page still works
    expect(out).toContain("Today&#x27;s schedule");
    expect(out).toContain("Thandi Nkosi");
    expect(out).toContain("Lerato Mokoena");
    expect(out).toContain("Payments received in March 2031");
  });

  it("a query that throws (not just returns an error) is contained too", async () => {
    h.resolve = (q) => { if (q.table === "appointments") throw new Error("socket hang up secret"); return base(q); };
    const out = await render();
    expect(out).toContain("We couldn&#x27;t load today&#x27;s schedule just now");
    expect(out).not.toContain("secret");
    expect(out).toContain("Lerato Mokoena");
  });

  it("keeps every list bounded and asks the database for counts, not rows", async () => {
    await render();
    // every list is capped; the one exception is the existing notesToComplete() helper (lib/notes/pending.ts), which reads at most the newest 500 attended sessions
    const notes = (q: Query) => q.calls.some((c) => c.m === "select" && String(c.a[0]).includes("clinical_notes"));
    const limits = h.log.filter((q) => !notes(q)).flatMap((q) => q.calls.filter((c) => c.m === "limit").map((c) => c.a[0] as number));
    expect(limits.length).toBeGreaterThan(4);
    expect(Math.max(...limits)).toBeLessThanOrEqual(50);
    expect(h.log.filter(notes).flatMap((q) => q.calls.filter((c) => c.m === "limit").map((c) => c.a[0]))).toEqual([500]);
    const heads = h.log.filter((q) => q.calls.some((c) => c.m === "select" && (c.a[1] as { head?: boolean } | undefined)?.head));
    expect(heads.length).toBeGreaterThanOrEqual(4); // tasks x2, claims x2
    expect(h.log.some((q) => q.table === "rpc:dashboard_payments_by_method")).toBe(true);
    const pay = h.log.find((q) => q.table === "rpc:dashboard_payments_by_method")!;
    expect(pay.calls[0].a[0]).toEqual({ p_from: "2031-03-01", p_to: "2031-03-10" });
    expect(h.log.some((q) => q.table === "payments")).toBe(false); // no payment rows are read
  });
});
