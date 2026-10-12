import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { called, type Query, type Result } from "../stubs/fake-supabase";

// The audit viewer and its CSV export with a fake client. 2031-03-10T07:30:00Z is 09:30 SAST.
const h = vi.hoisted(() => ({ role: "psychologist", resolve: (() => ({})) as (q: Query) => Result, log: [] as Query[], order: [] as string[], auditFails: false, audits: [] as unknown[][] }));
vi.mock("@/lib/auth/session", () => ({
  requireRole: async (allowed: string[]) => { if (!allowed.includes(h.role)) throw new Error("NOT_FOUND"); return { userId: "me", role: h.role }; },
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => (await import("../stubs/fake-supabase")).fakeSupabase((q) => { h.order.push(`query:${q.table}`); return h.resolve(q); }, h.log) }));
vi.mock("@/lib/audit", () => ({ audit: async (...a: unknown[]) => { h.order.push("audit"); if (h.auditFails) throw new Error("audit down"); h.audits.push(a); } }));

import AuditPage from "@/app/app/audit/page";
import { GET } from "@/app/app/audit/export/route";

const P = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const row = (i: number, o: Record<string, unknown> = {}) => ({
  id: i, role: "psychologist", action: "patient.update", entity: "patients", entity_id: P, at: "2031-03-10T07:00:00Z",
  detail: { fields: ["first_name", "phone"], note: "client disclosed something private", email: "a@b.co" }, ...o,
});
const page = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await AuditPage({ searchParams: Promise.resolve(sp) }));
const get = (qs = "") => GET(new Request(`http://localhost:3000/app/audit/export${qs}`));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-03-10T07:30:00Z"));
  h.role = "psychologist"; h.resolve = () => ({ data: [row(2), row(1, { role: null, action: "cron.reminders.run", entity: null, entity_id: null, detail: { reminders: 2, errors: ["send:x"], free: "text" } })], count: 2 });
  h.log.length = 0; h.order.length = 0; h.audits.length = 0; h.auditFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("/app/audit", () => {
  it("is psychologist only: admin and everyone else get a 404 and nothing is read or audited", async () => {
    for (const r of ["admin", "bookkeeper", "associate", "patient", "guardian"]) { h.role = r; await expect(page()).rejects.toThrow("NOT_FOUND"); await expect(get()).rejects.toThrow("NOT_FOUND"); }
    expect(h.log).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("audits the view BEFORE reading anything, with filter names only, and fails closed", async () => {
    await page({ prefix: "patient", from: "2031-03-01", entity: "bogus" });
    expect(h.order[0]).toBe("audit");
    expect(h.audits).toEqual([["audit.view", "audit_log", undefined, { filters: ["prefix", "from"], page: 1 }]]);
    h.log.length = 0; h.order.length = 0; h.audits.length = 0; h.auditFails = true;
    await expect(page()).rejects.toThrow("audit down");
    expect(h.log).toHaveLength(0); // nothing was read
  });

  it("shows time in SAST, role, action, entity, short entity id and a whitelisted detail", async () => {
    const out = await page();
    expect(out).toContain("2031-03-10 09:00"); // 07:00Z
    expect(out).toContain("<code");
    expect(out).toContain("patient.update");
    expect(out).toContain("Changed details");
    expect(out).toContain("patients");
    expect(out).toContain("9a1b2c3d");
    expect(out).toContain(`title="${P}"`); // ...the full id is a tooltip
    expect(out).toContain("fields: first_name, phone");
    expect(out).toContain("cron.reminders.run");
    expect(out).toContain("System");
    expect(out).toContain("reminders: 2; errors: 1");
  });

  it("never renders unknown or free-text detail keys", async () => {
    const out = await page();
    for (const leak of ["client disclosed", "a@b.co", "text</", "free"]) expect(out).not.toContain(leak);
  });

  it("filters: action prefix, entity, role and SAST date range, newest first, 50 per page", async () => {
    await page({ prefix: "claim", entity: "claims", role: "admin", from: "2031-03-09", to: "2031-03-10", page: "3" });
    const q = h.log.find((x) => x.table === "audit_log")!;
    expect(called(q, "like", "action", "claim.%")).toBe(true);
    expect(called(q, "eq", "entity", "claims")).toBe(true);
    expect(called(q, "eq", "role", "admin")).toBe(true);
    expect(called(q, "gte", "at", "2031-03-08T22:00:00.000Z")).toBe(true);
    expect(called(q, "lt", "at", "2031-03-10T22:00:00.000Z")).toBe(true);
    expect(called(q, "order", "at", { ascending: false })).toBe(true);
    expect(called(q, "range", 100, 149)).toBe(true);
    expect(JSON.stringify(q.calls)).not.toContain("actor"); // the actor's id is not even selected
  });

  it("offers the export link with the same filters, and an empty / failed state in plain words", async () => {
    expect(await page({ prefix: "note", role: "psychologist" })).toContain('href="/app/audit/export?prefix=note&amp;role=psychologist"');
    h.resolve = () => ({ data: [], count: 0 });
    expect(await page({ prefix: "note" })).toContain("Nothing matches these filters.");
    expect(await page()).toContain("Nothing has been recorded yet.");
    h.resolve = () => ({ error: { code: "XX000", message: "boom secret" } });
    const out = await page();
    expect(out).toContain("We could not load the audit log. Please refresh the page.");
    expect(out).not.toContain("boom");
  });
});

describe("/app/audit/export", () => {
  it("returns CSV with a download header, writes export.audit first, and neutralises formulas", async () => {
    h.resolve = () => ({ data: [row(1, { action: "=cmd|' /C calc'!A0", detail: { fields: ["a"] } }), row(2, { entity: "+evil" })] });
    const res = await get("?prefix=patient&from=2031-03-01");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="audit-log-2031-03-10.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const csv = await res.text();
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("time_sast,role,action,entity,entity_id,detail");
    expect(lines[1]).toBe(`2031-03-10 09:00,psychologist,'=cmd|' /C calc'!A0,patients,9a1b2c3d,fields: a`);
    expect(lines[2]).toContain(",'+evil,");
    expect(h.audits).toEqual([["export.audit", "audit_log", undefined, { filters: ["prefix", "from"], rows: 2, truncated: false }]]);
  });

  it("is fail-closed: when the audit row cannot be written the export is refused and no data is returned", async () => {
    h.auditFails = true;
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("refused");
    expect(body).not.toContain("patient.update");
    expect(body).not.toContain("time_sast");
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("a failed read is refused in plain words", async () => {
    h.resolve = () => ({ error: { code: "XX000", message: "boom secret" } });
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("boom");
    expect(h.audits).toHaveLength(0); // nothing was exported, nothing to record
  });

  it("reads in pages of 1000 and stops at 5000 rows, saying so when there is more", async () => {
    let n = 0;
    h.resolve = (q) => {
      const range = q.calls.find((c) => c.m === "range")!.a as number[];
      if (range[0] === 5000) return { data: [{ id: 1 }] }; // the probe beyond the cap
      n++; return { data: Array.from({ length: 1000 }, (_, i) => row(range[0] + i)) };
    };
    const res = await get();
    expect(n).toBe(5);
    expect((await res.text()).trimEnd().split("\n")).toHaveLength(5001);
    expect(res.headers.get("X-Export-Truncated")).toBe("true");
    expect(h.audits[0][3]).toEqual({ filters: [], rows: 5000, truncated: true });
    expect(h.log.map((x) => x.calls.find((c) => c.m === "range")!.a)).toEqual([[0, 999], [1000, 1999], [2000, 2999], [3000, 3999], [4000, 4999], [5000, 5000]]);
  });

  it("exactly 5000 rows is not truncated; a short last page ends the loop", async () => {
    h.resolve = (q) => {
      const range = q.calls.find((c) => c.m === "range")!.a as number[];
      if (range[0] === 5000) return { data: [] };
      return { data: Array.from({ length: 1000 }, (_, i) => row(range[0] + i)) };
    };
    expect(((await get()).headers.get("X-Export-Truncated"))).toBe("false");
    h.log.length = 0;
    h.resolve = (q) => ({ data: q.calls.find((c) => c.m === "range")!.a[0] === 0 ? Array.from({ length: 1000 }, (_, i) => row(i)) : [row(9999)] });
    const res = await get();
    expect((await res.text()).trimEnd().split("\n")).toHaveLength(1002);
    expect(h.log).toHaveLength(2);
  });

  it("an empty export is just the header", async () => {
    h.resolve = () => ({ data: [] });
    expect((await (await get()).text()).trim()).toBe("time_sast,role,action,entity,entity_id,detail");
  });
});
