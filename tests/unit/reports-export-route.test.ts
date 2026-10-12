import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { type Query, type Result } from "../stubs/fake-supabase";

// GET /app/reports/export with a fake RLS client and a recording audit function.
const h = vi.hoisted(() => ({
  role: "psychologist", resolve: (() => ({})) as (q: Query) => Result, log: [] as Query[], order: [] as string[],
  audits: [] as unknown[][], auditFails: false,
}));
vi.mock("@/lib/auth/session", () => ({
  requireRole: async (allowed: string[]) => { if (!allowed.includes(h.role)) throw new Error("NOT_FOUND"); return { userId: "me", role: h.role }; },
}));
vi.mock("@/lib/audit", () => ({
  audit: async (...a: unknown[]) => { h.order.push("audit"); h.audits.push(a); if (h.auditFails) throw new Error("audit_append failed"); },
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => (await import("../stubs/fake-supabase")).fakeSupabase((q) => { h.order.push(q.table); return h.resolve(q); }, h.log),
}));

import { GET } from "@/app/app/reports/export/route";

const URL_BASE = "http://localhost:3000/app/reports/export";
const get = (qs: string, headers: Record<string, string> = {}) => GET(new Request(`${URL_BASE}?${qs}`, { headers }));
const OK = "report=income_by_month&from=2031-01-01&to=2031-03-31";
const rpcArgs = (q: Query) => q.calls.find((c) => c.m === "rpc")?.a[0] as Record<string, string>;
let vat = false;
let rows: Record<string, unknown[]>;
const base = (q: Query): Result => {
  if (q.table.startsWith("rpc:")) return { data: rows[q.table.slice(4)] ?? [] };
  if (q.table === "practices") return { data: { vat_registered: vat } };
  return {};
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-03-10T07:30:00Z"));
  h.role = "psychologist"; h.resolve = base; h.log.length = 0; h.order.length = 0; h.audits.length = 0; h.auditFails = false; vat = false;
  rows = {
    report_income_by_month: [{ month_start: "2031-01-01", invoices_n: 2, invoiced_cents: 123450, vat_cents: 16102, received_cents: 50000, credit_cents: 1150 }],
    report_transactions: [
      { txn_date: "2031-01-05", kind: "payment", invoice_number: "INV-00001", method: "eft", reference: "=cmd|' /C calc'!A0", portion: "patient", amount_cents: 5750, vat_cents: null },
      { txn_date: "2031-01-06", kind: "credit_note", invoice_number: "INV-00001", method: "credit_note", reference: null, portion: "patient", amount_cents: -1150, vat_cents: null },
    ],
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("report CSV export: the happy path", () => {
  it("returns a no-store, nosniff attachment named after the report and the dates, with a fixed header and numeric rand", async () => {
    const res = await get(OK);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="income_by_month-2031-01-01-2031-03-31.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await res.text()).toBe("month,invoices,invoiced_zar,vat_zar,received_zar,credit_notes_zar\n2031-01,2,1234.5,,500,11.5\n");
  });
  it("VAT is filled in only for a VAT-registered practice", async () => {
    vat = true;
    expect((await (await get(OK)).text()).split("\n")[1]).toBe("2031-01,2,1234.5,161.02,500,11.5");
  });
  it("calls the report function with the SQL parameter names, as the signed-in user's client", async () => {
    await get(OK);
    expect(rpcArgs(h.log.find((q) => q.table === "rpc:report_income_by_month")!)).toEqual({ p_from: "2031-01-01", p_to: "2031-03-31" });
  });
  it("the audit row (export.report) holds the report, the dates and the row count only, and is written after the read and before the response", async () => {
    await get(OK);
    expect(h.audits).toEqual([["export.report", undefined, undefined, { report: "income_by_month", from: "2031-01-01", to: "2031-03-31", rows: 1 }]]);
    expect(h.order.indexOf("rpc:report_income_by_month")).toBeLessThan(h.order.indexOf("audit"));
  });
  it("every text cell is neutralised against spreadsheet formulas, and a credit note stays a negative number", async () => {
    const out = await (await get("report=transactions&from=2031-01-01&to=2031-01-31")).text();
    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toBe("date,type,invoice_number,method,reference,portion,amount_zar,vat_zar");
    expect(lines[1]).toBe("2031-01-05,payment,INV-00001,eft,'=cmd|' /C calc'!A0,patient,57.5,");
    expect(lines[2]).toBe("2031-01-06,credit note,INV-00001,credit_note,,patient,-11.5,");
  });
  it("an empty report is the header line only, and is still audited with 0 rows", async () => {
    rows = {};
    const res = await get("report=income_by_method&from=2031-01-01&to=2031-01-31");
    expect(await res.text()).toBe("method,payments,received_zar\n");
    expect(h.audits[0][3]).toMatchObject({ report: "income_by_method", rows: 0 });
  });
  it("debtors are read as at the end of the period, or today when the period runs on", async () => {
    await get("report=debtors&from=2031-01-01&to=2031-02-15");
    await get("report=debtors&from=2031-01-01&to=2031-12-31");
    const args = h.log.filter((q) => q.table === "rpc:report_debtors_detail").map(rpcArgs);
    expect(args).toEqual([{ p_as_of: "2031-02-15" }, { p_as_of: "2031-03-10" }]);
  });
});

describe("report CSV export: refusals read and audit nothing", () => {
  const nothing = () => { expect(h.log).toHaveLength(0); expect(h.audits).toHaveLength(0); };
  it("prefetch / RSC requests get an empty 204", async () => {
    for (const hd of <Record<string, string>[]>[{ "next-router-prefetch": "1" }, { rsc: "1" }, { purpose: "prefetch" }, { "sec-purpose": "prefetch;prerender" }]) {
      const res = await get(OK, hd);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
    nothing();
  });
  it("people who cannot open reports get a 404 from requireRole", async () => {
    for (const role of ["associate", "patient", "guardian"]) { h.role = role; await expect(get(OK)).rejects.toThrow("NOT_FOUND"); }
    nothing();
  });
  it("an unknown report key or bad dates are a 400", async () => {
    for (const qs of [
      "report=audit_log&from=2031-01-01&to=2031-01-31", "report=&from=2031-01-01&to=2031-01-31", "from=2031-01-01&to=2031-01-31", "report=income_by_month&from=2031-01-01",
      "report=income_by_month&from=2031-02-30&to=2031-03-01", "report=income_by_month&from=2031-03-01&to=2031-01-01", "report=income_by_month&from=2020-01-01&to=2031-01-01", "report=income_by_month&from=x&to=y",
    ]) {
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    nothing();
  });
  it("a role that cannot see that report gets a 403 before anything is read", async () => {
    const cases: [string, string][] = [["bookkeeper", "appointments"], ["bookkeeper", "activity"], ["bookkeeper", "compliance"], ["admin", "compliance"]];
    for (const [role, report] of cases) {
      h.role = role;
      const res = await get(`report=${report}&from=2031-01-01&to=2031-01-31`);
      expect(res.status, `${role} ${report}`).toBe(403);
    }
    nothing();
  });
  it("each role gets exactly its own reports", async () => {
    const want: Record<string, string[]> = {
      psychologist: ["income_by_month", "income_by_method", "income_by_session_type", "debtors", "appointments", "activity", "compliance", "transactions"],
      admin: ["income_by_month", "income_by_method", "income_by_session_type", "debtors", "appointments", "activity", "transactions"],
      bookkeeper: ["income_by_month", "income_by_method", "income_by_session_type", "debtors", "transactions"],
    };
    for (const [role, keys] of Object.entries(want)) {
      h.role = role;
      const got: string[] = [];
      for (const k of ["income_by_month", "income_by_method", "income_by_session_type", "debtors", "appointments", "activity", "compliance", "transactions"])
        if ((await get(`report=${k}&from=2031-01-01&to=2031-01-31`)).status === 200) got.push(k);
      expect(got, role).toEqual(keys);
    }
  });
});

describe("report CSV export: failing closed", () => {
  it("if the audit row cannot be written the export is refused with a 500 and no data", async () => {
    h.auditFails = true;
    const res = await get(OK);
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Nothing was downloaded");
    expect(body).not.toContain("month,invoices");
    expect(body).not.toContain("2031-01");
  });
  it("a failed read is a 500 with no data and no audit row; the message is never repeated", async () => {
    h.resolve = (q) => (q.table.startsWith("rpc:") ? { error: { code: "P0001", message: "secret value" } } : base(q));
    const res = await get(OK);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret");
    expect(h.audits).toHaveLength(0);
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ")).not.toContain("secret value");
  });
  it("too many transaction lines is a 422 telling the person to shorten the period", async () => {
    h.resolve = (q) => (q.table === "rpc:report_transactions" ? { error: { code: "P0001", message: "too_many_rows" } } : base(q));
    const res = await get("report=transactions&from=2031-01-01&to=2031-03-01");
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("shorter period");
    expect(h.audits).toHaveLength(0);
  });
});
