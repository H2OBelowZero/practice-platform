import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { called, type Query, type Result } from "../stubs/fake-supabase";

// The tasks page and its server actions with a fake RLS client. 2031-03-10T07:30:00Z is 09:30 SAST on Monday 10 March 2031.
const h = vi.hoisted(() => ({ role: "psychologist", resolve: (() => ({})) as (q: Query) => Result, log: [] as Query[], audits: [] as unknown[][], auditFails: false }));
vi.mock("@/lib/auth/session", () => ({
  requireRole: async (allowed: string[]) => { if (!allowed.includes(h.role)) throw new Error("NOT_FOUND"); return { userId: "me", role: h.role }; },
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => (await import("../stubs/fake-supabase")).fakeSupabase((q) => h.resolve(q), h.log) }));
vi.mock("@/lib/audit", () => ({ audit: async (...a: unknown[]) => { if (h.auditFails) throw new Error("audit down"); h.audits.push(a); } }));

import TasksPage from "@/app/app/tasks/page";
import NewTaskPage from "@/app/app/tasks/new/page";
import { createTask, setTaskStatus, updateTask } from "@/app/app/tasks/actions";

const T1 = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", T2 = "4a6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", T3 = "5b6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", T4 = "6c6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d";
const T5 = "7d6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", T6 = "8e6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d";
const P = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", I = "11111111-2222-4333-8444-555555555555", N = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const task = (o: Record<string, unknown>) => ({ id: T1, title: "A task", due_at: null, priority: "normal", status: "open", source: "manual", patient_id: null, appointment_id: null, meta: null, created_at: "2031-03-01T00:00:00Z", ...o });

const rows = [
  task({ id: T1, title: "Call the medical aid", due_at: "2031-03-08T22:00:00.000Z", priority: "high", patient_id: P }), // due 9 March: overdue
  task({ id: T2, title: "PayFast payment needs reconciliation", source: "payfast_unreconciled:1089250", patient_id: P, priority: "high",
    meta: { invoice_id: I, pf_payment_id: "1089250", reason: "invoice_not_payable", amount_cents: 95000, outstanding_cents: 0 } }),
  task({ id: T3, title: "Notification could not be sent", source: "outbox_failed:42", meta: { template: "reminder_24h", channel: "email" } }),
  task({ id: T4, title: "Clinical follow-up", source: `risk_flag:${N}`, patient_id: P, priority: "high", meta: { level: "high" } }),
  task({ id: T5, title: "Possible duplicate patient: review and merge", source: "duplicate_patient", patient_id: P }),
  task({ id: T6, title: "Consent withdrawn: telehealth", source: "consent_withdrawn", patient_id: P, due_at: "2031-03-09T22:00:00.000Z" }), // due today
];
const base = (q: Query): Result => q.table === "tasks" ? { data: rows, count: rows.length } : q.table === "patients" ? { data: [{ id: P, first_name: "Thandi", last_name: "Nkosi" }] } : {};
const page = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await TasksPage({ searchParams: Promise.resolve(sp) }));
const newPage = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await NewTaskPage({ searchParams: Promise.resolve(sp) }));
const redirectOf = async (p: Promise<unknown>) => { try { await p; return "no redirect"; } catch (e) { return (e as Error).message; } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-03-10T07:30:00Z"));
  h.role = "psychologist"; h.resolve = base; h.log.length = 0; h.audits.length = 0; h.auditFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("/app/tasks", () => {
  it("lists each task with priority (icon + text), due state, patient link and the source link", async () => {
    const out = await page();
    expect(out).toContain("Call the medical aid");
    expect(out).toContain("High priority");
    expect(out).toContain("Overdue"); // chip text
    expect(out).toContain("Due today (Mon 10 Mar 2031)");
    expect(out).toContain(`href="/app/patients/${P}">Thandi Nkosi`);
    expect(out).toContain(`href="/app/billing/${I}">Open invoice`);
    expect(out).toContain(`href="/app/patients/${P}?tab=forms">Open consents`);
    expect(out).toContain(`href="/app/patients/${P}">Open patient`);
    expect(out).toMatch(/Mark done<span class="sr-only">: Call the medical aid/);
    expect(out).toContain("Change due date or priority");
    expect(out).toContain('name="due"');
  });

  it("shows the PayFast figures in a clear block", async () => {
    const out = await page();
    expect(out).toContain("Payment received at PayFast that could not be matched");
    expect(out).toContain("PayFast took R 950,00. The invoice had R 0,00 outstanding.");
    expect(out).toContain("no longer accepts payments");
  });

  it("a system task with nothing to open has an explanation and no link", async () => {
    const out = await page();
    expect(out).toContain("could not be delivered after several tries");
    const li = out.split("<li").find((s) => s.includes("Notification could not be sent"))!;
    expect(li).not.toContain("<a ");
    expect(li).toContain("Mark done");
  });

  it("a risk task shows its plain title only, and links to the note", async () => {
    const out = await page();
    expect(out).toContain("Clinical follow-up");
    expect(out).toContain("Clinical risk");
    expect(out).toContain(`href="/app/notes/${N}">Open note`);
    expect(out).not.toContain('"level"');
  });

  it("offers the Clinical risk filter to the psychologist only, and the admin's query is RLS-filtered like any other", async () => {
    expect(await page()).toContain('<option value="clinical">Clinical risk</option>');
    expect(await page()).toContain('<option value="payfast">Unmatched PayFast payments</option>');
    h.role = "admin";
    const out = await page();
    expect(out).not.toContain('<option value="clinical">');
    expect(out).toContain("Billing");
  });

  it("builds the query from the filters: status, priority, due (SAST day bounds), group, paging", async () => {
    await page({ status: "done", priority: "high", due: "overdue", group: "billing", page: "2" });
    const q = h.log.find((x) => x.table === "tasks")!;
    expect(called(q, "eq", "status", "done")).toBe(true);
    expect(called(q, "eq", "priority", "high")).toBe(true);
    expect(called(q, "lt", "due_at", "2031-03-09T22:00:00.000Z")).toBe(true);
    expect(q.calls.find((c) => c.m === "or")?.a[0]).toContain('source.like."payfast_unreconciled:*"');
    expect(called(q, "range", 25, 49)).toBe(true);
    await page({ due: "none" });
    expect(called(h.log.filter((x) => x.table === "tasks").at(-1)!, "is", "due_at", null)).toBe(true);
  });

  it("ignores junk in the filters", async () => {
    await page({ status: "x'--", priority: "urgent", due: "never", group: "all", page: "-4" });
    const q = h.log.find((x) => x.table === "tasks")!;
    expect(called(q, "eq", "status", "open")).toBe(true);
    expect(q.calls.some((c) => c.m === "eq" && c.a[0] === "priority")).toBe(false);
    expect(q.calls.some((c) => c.m === "or")).toBe(false);
    expect(called(q, "range", 0, 24)).toBe(true);
  });

  it("empty and failed states are plain", async () => {
    h.resolve = () => ({ data: [], count: 0 });
    expect(await page()).toContain("There are no open tasks. Nothing is waiting on you.");
    expect(await page({ priority: "low" })).toContain("No tasks match. Try different filters.");
    h.resolve = () => ({ error: { code: "XX000", message: "boom secret" } });
    const out = await page();
    expect(out).toContain("We could not load the tasks. Please refresh the page.");
    expect(out).not.toContain("boom");
  });

  it("is psychologist and admin only", async () => {
    for (const r of ["bookkeeper", "associate", "patient", "guardian"]) { h.role = r; await expect(page()).rejects.toThrow("NOT_FOUND"); await expect(newPage()).rejects.toThrow("NOT_FOUND"); }
    expect(h.log).toHaveLength(0);
  });
});

describe("/app/tasks/new", () => {
  it("shows the form, with a patient search, and a chosen patient as a hidden field", async () => {
    let out = await newPage();
    expect(out).toContain("What needs doing");
    expect(out).toContain("Patient name");
    expect(out).not.toContain('name="patientId"');
    h.resolve = (q) => (q.table === "patients" ? { data: [{ id: P, first_name: "Thandi", last_name: "Nkosi" }] } : {});
    out = await newPage({ q: "thandi" });
    expect(out).toContain(`href="/app/tasks/new?patient=${P}&amp;q=thandi"`);
    out = await newPage({ patient: P });
    expect(out).toContain(`type="hidden" name="patientId" value="${P}"`);
    expect(out).toContain("Thandi Nkosi");
  });
  it("search text cannot inject filter syntax", async () => {
    h.resolve = () => ({ data: [] });
    await newPage({ q: "a,b.eq.(x)%" });
    const q = h.log.find((x) => x.table === "patients")!;
    expect(JSON.stringify(q.calls)).not.toMatch(/\(x\)|%b|,b\./);
  });
});

describe("task actions", () => {
  const full = { title: "Phone Thandi", due: "2031-03-12", priority: "high", patientId: "" };

  it("createTask: requireRole, validates, inserts a manual task through the user client, audits ids and field names only", async () => {
    h.resolve = (q) => (q.table === "tasks" ? { data: [{ id: T1 }] } : {});
    expect(await redirectOf(createTask(full))).toBe("REDIRECT:/app/tasks?notice=created");
    const q = h.log.find((x) => x.table === "tasks")!;
    expect(q.calls.find((c) => c.m === "insert")?.a[0]).toEqual({ title: "Phone Thandi", due_at: "2031-03-11T22:00:00.000Z", priority: "high", patient_id: null, source: "manual" });
    expect(h.audits).toEqual([["task.create", "tasks", T1, { fields: ["title", "priority", "due_at"] }]]);
    expect(JSON.stringify(h.audits)).not.toContain("Phone Thandi");
  });
  it("createTask with a patient checks the patient exists first", async () => {
    h.resolve = (q) => (q.table === "tasks" ? { data: [{ id: T1 }] } : { data: [{ id: P }] });
    await redirectOf(createTask({ ...full, patientId: P }));
    expect(h.log[0].table).toBe("patients");
    expect(h.log.find((x) => x.table === "tasks")!.calls.find((c) => c.m === "insert")?.a[0]).toMatchObject({ patient_id: P });
    h.log.length = 0;
    h.resolve = () => ({ data: [] });
    expect(await createTask({ ...full, patientId: P })).toEqual({ error: "We could not find that patient. Choose the patient again.", field: "patientId" });
    expect(h.log.some((x) => x.calls.some((c) => c.m === "insert"))).toBe(false);
  });
  it("createTask rejects bad input before touching the database", async () => {
    expect(await createTask({ ...full, title: "  " })).toMatchObject({ error: "Give the task a title.", field: "title" });
    expect(await createTask({ ...full, title: "x".repeat(201) })).toMatchObject({ field: "title" });
    expect(await createTask({ ...full, due: "2031-02-31" })).toMatchObject({ field: "due" });
    expect(await createTask({ ...full, priority: "urgent" })).toMatchObject({ field: "priority" });
    expect(h.log).toHaveLength(0);
    h.role = "bookkeeper";
    await expect(createTask(full)).rejects.toThrow("NOT_FOUND");
  });
  it("createTask still succeeds if only the audit write fails (fail-open, R32), and says nothing technical", async () => {
    h.resolve = (q) => (q.table === "tasks" ? { data: [{ id: T1 }] } : {});
    h.auditFails = true;
    expect(await redirectOf(createTask(full))).toBe("REDIRECT:/app/tasks?notice=created");
  });
  it("createTask reports a failed save in plain words", async () => {
    h.resolve = () => ({ error: { code: "42501", message: "new row violates row-level security policy secret" } });
    const r = await createTask(full);
    expect(r).toEqual({ error: "We could not save that. Please try again." });
  });

  it("updateTask writes and audits only the fields that changed", async () => {
    h.resolve = (q) => (q.calls.some((c) => c.m === "update") ? { data: [{ id: T1 }] } : { data: [{ id: T1, due_at: "2031-03-08T22:00:00.000Z", priority: "normal" }] });
    expect(await redirectOf(updateTask(T1, "/app/tasks?status=open&page=2", { due: "2031-03-20", priority: "normal" }))).toBe("REDIRECT:/app/tasks?status=open&page=2&notice=updated");
    const upd = h.log.flatMap((x) => x.calls.filter((c) => c.m === "update")).map((c) => c.a[0]);
    expect(upd).toEqual([{ due_at: "2031-03-19T22:00:00.000Z" }]);
    expect(h.audits).toEqual([["task.update", "tasks", T1, { fields: ["due_at"] }]]);
  });
  it("updateTask with nothing changed writes and audits nothing; clearing the date is a change", async () => {
    h.resolve = () => ({ data: [{ id: T1, due_at: "2031-03-08T22:00:00.000Z", priority: "normal" }] });
    expect(await redirectOf(updateTask(T1, "/app/tasks", { due: "2031-03-09", priority: "normal" }))).toBe("REDIRECT:/app/tasks?notice=unchanged");
    expect(h.audits).toEqual([]);
    h.resolve = (q) => (q.calls.some((c) => c.m === "update") ? { data: [{ id: T1 }] } : { data: [{ id: T1, due_at: "2031-03-08T22:00:00.000Z", priority: "normal" }] });
    await redirectOf(updateTask(T1, "/app/tasks", { due: "", priority: "low" }));
    expect(h.log.flatMap((x) => x.calls.filter((c) => c.m === "update")).map((c) => c.a[0]).at(-1)).toEqual({ due_at: null, priority: "low" });
    expect(h.audits.at(-1)).toEqual(["task.update", "tasks", T1, { fields: ["due_at", "priority"] }]);
  });
  it("updateTask: a task the user cannot see (a risk task for the admin) is simply not found, and an off-site return address is ignored", async () => {
    h.resolve = () => ({ data: [] });
    expect(await updateTask(T4, "/app/tasks", { due: "", priority: "low" })).toEqual({ error: "We could not find that task. It may have been removed." });
    expect(await updateTask("not-an-id", "/app/tasks", { due: "", priority: "low" })).toMatchObject({ error: expect.stringContaining("could not find") });
    h.resolve = (q) => (q.calls.some((c) => c.m === "update") ? { data: [{ id: T1 }] } : { data: [{ id: T1, due_at: null, priority: "normal" }] });
    expect(await redirectOf(updateTask(T1, "https://evil.example/x", { due: "", priority: "high" }))).toBe("REDIRECT:/app/tasks?notice=updated");
  });
  it("updateTask reports an update that touched no row (RLS) as a failed save", async () => {
    h.resolve = (q) => (q.calls.some((c) => c.m === "update") ? { data: [] } : { data: [{ id: T1, due_at: null, priority: "normal" }] });
    expect(await updateTask(T1, "/app/tasks", { due: "", priority: "high" })).toEqual({ error: "We could not save that. Please try again." });
    expect(h.audits).toEqual([]);
  });

  it("setTaskStatus: done audits task.complete, reopen audits task.reopen, repeating is harmless", async () => {
    h.resolve = (q) => (q.calls.some((c) => c.m === "update") ? { data: [{ id: T1 }] } : { data: [{ id: T1, status: "open" }] });
    expect(await redirectOf(setTaskStatus(T1, "done", "/app/tasks?priority=high"))).toBe("REDIRECT:/app/tasks?priority=high&notice=done");
    expect(h.log.flatMap((x) => x.calls.filter((c) => c.m === "update")).map((c) => c.a[0])).toEqual([{ status: "done" }]);
    expect(h.audits).toEqual([["task.complete", "tasks", T1]]);
    h.resolve = (q) => (q.calls.some((c) => c.m === "update") ? { data: [{ id: T1 }] } : { data: [{ id: T1, status: "done" }] });
    expect(await redirectOf(setTaskStatus(T1, "open", "/app/tasks"))).toBe("REDIRECT:/app/tasks?notice=reopened");
    expect(h.audits.at(-1)).toEqual(["task.reopen", "tasks", T1]);
    const n = h.audits.length;
    expect(await redirectOf(setTaskStatus(T1, "done", "/app/tasks"))).toBe("REDIRECT:/app/tasks?notice=done"); // already done: no second write, no second audit row
    expect(h.audits.length).toBe(n);
  });
  it("setTaskStatus refuses a bad status or id, and other roles", async () => {
    expect(await setTaskStatus(T1, "deleted", "/app/tasks")).toMatchObject({ error: expect.stringContaining("could not find") });
    expect(await setTaskStatus("x", "done", "/app/tasks")).toMatchObject({ error: expect.stringContaining("could not find") });
    h.role = "associate";
    await expect(setTaskStatus(T1, "done", "/app/tasks")).rejects.toThrow("NOT_FOUND");
  });
});
