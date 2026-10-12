import { describe, it, expect } from "vitest";
import { AUDIT_DETAIL_KEYS, auditDetailParts, auditDetailSummary, auditTime, shortEntityId } from "@/lib/audit-viewer/detail";
import { activeFilterNames, applyAuditFilters, AUDIT_ENTITIES, AUDIT_PREFIXES, filterParams, isPrefetch, parseAuditFilters } from "@/lib/audit-viewer/filters";
import { toCsv } from "@/lib/reports/csv";

const P = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

describe("auditDetailParts: whitelist", () => {
  it("shows ids (shortened), versions, counts, reason codes and field names", () => {
    expect(auditDetailParts({ patient_id: P, version: 3, reason: "invoice_not_payable", fields: ["first_name", "phone"] }))
      .toEqual(["patient id: 9a1b2c3d", "version: 3", "reason: invoice_not_payable", "fields: first_name, phone"]);
    expect(auditDetailParts({ reminders: 2, overdueTasks: 1, sent: 0, errors: ["audit_append:XX000", "send:x"] })).toEqual(["reminders: 2", "overdue tasks: 1", "sent: 0", "errors: 2"]);
    expect(auditDetailParts({ late: true, duplicate_confirmed: false })).toEqual(["late: yes", "duplicate confirmed: no"]);
  });
  it("drops every key that is not on the list, including free text, names and amounts", () => {
    const d = { note: "client disclosed ...", email: "a@b.co", first_name: "Thandi", amount_cents: 95000, text: "hello", reason_text: "x", pf_payment_id: "123", recipient: "a@b.co" };
    expect(auditDetailParts(d)).toEqual([]);
    expect(auditDetailSummary({ ...d, version: 1 })).toBe("version: 1");
  });
  it("drops listed keys whose value has the wrong shape", () => {
    expect(auditDetailParts({ patient_id: "Thandi Nkosi", invoice_id: "../../x", version: "3", count: -1, rows: 1.5, reason: "Free text with spaces!", status: "<script>", fields: "first_name" })).toEqual([]);
    expect(auditDetailParts({ fields: ["ok_name", "Bad Name", "x".repeat(60), 5, null, { a: 1 }] })).toEqual(["fields: ok_name"]);
    expect(auditDetailParts({ reason: "a".repeat(80) })).toEqual([]);
  });
  it("never throws on odd input", () => {
    for (const v of [null, undefined, 5, "text", [], [{ patient_id: P }], { fields: [[["x"]]] }]) expect(() => auditDetailParts(v)).not.toThrow();
    expect(auditDetailParts(null)).toEqual([]);
    expect(auditDetailParts([{ patient_id: P }])).toEqual([]);
    expect(auditDetailParts(JSON.parse('{"__proto__": {"version": 9}, "constructor": 1}'))).toEqual([]);
  });
  it("lists the whitelist so a new key is a deliberate change", () => {
    expect([...AUDIT_DETAIL_KEYS].sort()).toMatchInlineSnapshot(`
      [
        "appointment_id",
        "attempts",
        "by_role",
        "channel",
        "claim_id",
        "claimed",
        "code",
        "count",
        "deferred",
        "duplicate_confirmed",
        "errors",
        "failed",
        "fields",
        "filters",
        "from",
        "invoice_id",
        "key",
        "late",
        "member_id",
        "method",
        "note_id",
        "op",
        "outcome",
        "overdueTasks",
        "page",
        "patient_id",
        "payment_id",
        "reason",
        "reminders",
        "report",
        "retried",
        "rows",
        "sensitive",
        "sent",
        "status",
        "submission_id",
        "task_id",
        "template",
        "to",
        "truncated",
        "version",
      ]
    `);
  });
  it("shows a report export as the report key, the two dates and the row count, and drops a malformed date", () => {
    expect(auditDetailParts({ report: "income_by_month", from: "2030-01-01", to: "2030-03-31", rows: 4 })).toEqual(["rows: 4", "report: income_by_month", "from: 2030-01-01", "to: 2030-03-31"]);
    expect(auditDetailParts({ report: "x y", from: "tomorrow", to: "2030-3-1" })).toEqual([]);
  });
  it("short ids and the SAST time", () => {
    expect(shortEntityId(P)).toBe("9a1b2c3d");
    expect(shortEntityId(null)).toBe("");
    expect(shortEntityId("not-an-id")).toBe("");
    expect(auditTime("2031-03-10T22:30:00Z")).toBe("2031-03-11 00:30");
  });
});

describe("filters", () => {
  it("accepts only listed values and real dates", () => {
    expect(parseAuditFilters({ prefix: "patient", entity: "patients", role: "admin", from: "2031-03-01", to: "2031-03-31" }))
      .toEqual({ prefix: "patient", entity: "patients", role: "admin", from: "2031-03-01", to: "2031-03-31" });
    expect(parseAuditFilters({ prefix: "patient%", entity: "x; drop table", role: "root", from: "2031-02-30", to: "yesterday" }))
      .toEqual({ prefix: "", entity: "", role: "", from: "", to: "" });
    expect(parseAuditFilters({})).toEqual({ prefix: "", entity: "", role: "", from: "", to: "" });
    expect(AUDIT_PREFIXES).toContain("export");
    expect(AUDIT_PREFIXES).toContain("audit");
    expect(AUDIT_PREFIXES).toContain("settings"); // the 0027 trigger writes settings.change / settings.payment_instructions
    for (const e of ["practices", "session_types", "availability_rules", "blocked_times", "retention_policies"]) expect(AUDIT_ENTITIES).toContain(e);
    expect(AUDIT_ENTITIES).toContain("audit_log");
  });
  it("reports which filters are set, by name", () => {
    expect(activeFilterNames(parseAuditFilters({ prefix: "claim", from: "2031-03-01" }))).toEqual(["prefix", "from"]);
    expect(filterParams(parseAuditFilters({ prefix: "claim" })).prefix).toBe("claim");
  });
  it("applies them to a query: prefix as a LIKE on action, equality for entity and role, SAST day bounds for dates", () => {
    const calls: string[] = [];
    const q = { like: (c: string, v: string) => (calls.push(`like ${c} ${v}`), q), eq: (c: string, v: string) => (calls.push(`eq ${c} ${v}`), q),
      gte: (c: string, v: string) => (calls.push(`gte ${c} ${v}`), q), lt: (c: string, v: string) => (calls.push(`lt ${c} ${v}`), q) };
    applyAuditFilters(q, parseAuditFilters({ prefix: "note", entity: "clinical_notes", role: "psychologist", from: "2031-03-10", to: "2031-03-10" }));
    expect(calls).toEqual([
      "like action note.%", "eq entity clinical_notes", "eq role psychologist",
      "gte at 2031-03-09T22:00:00.000Z", "lt at 2031-03-10T22:00:00.000Z", // the whole SAST day of the 10th
    ]);
    calls.length = 0;
    applyAuditFilters(q, parseAuditFilters({}));
    expect(calls).toEqual([]);
  });
});

describe("audit export rows", () => {
  it("run through toCsv: commas and quotes are escaped and a formula starter is neutralised", () => {
    const rows = [{ time_sast: "2031-03-10 14:30", role: "psychologist", action: "=cmd|' /C calc'!A0", entity: "patients", entity_id: P.slice(0, 8), detail: "fields: first_name, phone" }];
    const out = toCsv(rows);
    expect(out.split("\n")[1]).toBe(`2031-03-10 14:30,psychologist,'=cmd|' /C calc'!A0,patients,9a1b2c3d,"fields: first_name, phone"`);
  });
});

describe("hideViews and prefetch detection", () => {
  const rec = () => { const calls: string[] = []; const q: Record<string, unknown> = {}; for (const m of ["like", "neq", "eq", "gte", "lt"]) q[m] = (c: string, v: string) => (calls.push(`${m} ${c} ${v}`), q); return { q, calls }; };
  it("leaves audit.view out unless asked, and only for the viewer", () => {
    const a = rec(); applyAuditFilters(a.q, parseAuditFilters({}), { hideViews: true });
    expect(a.calls).toEqual(["neq action audit.view"]);
    const b = rec(); applyAuditFilters(b.q, parseAuditFilters({ prefix: "audit" }), { hideViews: true });
    expect(b.calls).toEqual(["like action audit.%"]);
    const c = rec(); applyAuditFilters(c.q, parseAuditFilters({}));
    expect(c.calls).toEqual([]); // the export keeps every row
  });
  it("recognises the headers a router or browser sends when warming a link", () => {
    const h = (o: HeadersInit) => new Headers(o);
    for (const o of [{ "next-router-prefetch": "1" }, { rsc: "1" }, { purpose: "prefetch" }, { "sec-purpose": "prefetch;prerender" }] as Record<string, string>[]) expect(isPrefetch(h(o)), JSON.stringify(o)).toBe(true);
    for (const o of [{}, { accept: "text/csv" }, { purpose: "navigate" }, { "sec-fetch-dest": "document" }] as Record<string, string>[]) expect(isPrefetch(h(o)), JSON.stringify(o)).toBe(false);
  });
});

describe("settings changes (0027)", () => {
  it("shows the operation, the retention key, the sensitive flag and the field NAMES, nothing else", () => {
    expect(auditDetailParts({ op: "update", fields: ["payment_instructions"], sensitive: true })).toEqual(expect.arrayContaining(["op: update", "sensitive: yes", "fields: payment_instructions"]));
    expect(auditDetailParts({ op: "update", key: "clinical_notes", fields: ["legal_hold", "retain_years"] })).toEqual(expect.arrayContaining(["key: clinical_notes", "fields: legal_hold, retain_years"]));
    expect(auditDetailParts({ op: "Bank: Evil acc 123", fields: ["Bank: Evil"] })).toEqual([]); // free text is still dropped
  });
});
