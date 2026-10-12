import { describe, it, expect } from "vitest";
import { toCsv } from "@/lib/reports/csv";
import { EXPORT_COLUMNS, exportRows, activityCsv, complianceCsv, transactionsCsv, debtorsCsv, appointmentsCsv, incomeByMonthCsv } from "@/lib/reports/exports";
import { EXPORT_KEYS } from "@/lib/reports/keys";
import { ReportQueryError, fetchIncomeByMonth, shapeActivity, shapeCompliance, type FlatRow } from "@/lib/reports/queries";
import type { SupabaseClient } from "@supabase/supabase-js";

const fake = (data: Record<string, unknown[]>, error?: { code: string; message: string }) => {
  const calls: { fn: string; args: unknown }[] = [];
  const sb = { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: error ? null : (data[fn] ?? []), error: error ?? null }; } };
  return { sb: sb as unknown as SupabaseClient, calls };
};

describe("CSV column definitions are stable", () => {
  it("headers per report (a change here is a change for the accountant's spreadsheet)", () => {
    expect(EXPORT_COLUMNS).toMatchInlineSnapshot(`
      {
        "activity": [
          "section",
          "item",
          "value",
        ],
        "appointments": [
          "session_type",
          "booked",
          "attended",
          "no_show",
          "cancelled",
          "late_cancelled",
          "booked_minutes",
          "available_minutes",
          "utilisation_pct",
          "no_show_rate_pct",
          "cancellation_rate_pct",
        ],
        "compliance": [
          "section",
          "item",
          "status",
          "count",
        ],
        "debtors": [
          "as_of",
          "invoice_number",
          "due_date",
          "days_overdue",
          "age_bucket",
          "payer",
          "outstanding_zar",
          "scheme_zar",
          "patient_zar",
        ],
        "income_by_method": [
          "method",
          "payments",
          "received_zar",
        ],
        "income_by_month": [
          "month",
          "invoices",
          "invoiced_zar",
          "vat_zar",
          "received_zar",
          "credit_notes_zar",
        ],
        "income_by_session_type": [
          "session_type",
          "invoices",
          "invoiced_zar",
        ],
        "transactions": [
          "date",
          "type",
          "invoice_number",
          "method",
          "reference",
          "portion",
          "amount_zar",
          "vat_zar",
        ],
      }
    `);
  });
  it("every export key has columns and none of them can carry a patient identity", () => {
    expect(Object.keys(EXPORT_COLUMNS).sort()).toEqual([...EXPORT_KEYS].sort());
    for (const cols of Object.values(EXPORT_COLUMNS)) for (const c of cols) expect(c).not.toMatch(/patient_id|name|email|phone|birth|^id$/);
  });
  it("an empty export still has its header line", () => {
    for (const k of EXPORT_KEYS) expect(toCsv([], EXPORT_COLUMNS[k])).toBe(EXPORT_COLUMNS[k].join(","));
  });
});

describe("row shaping", () => {
  it("income by month: rand as numbers, month as YYYY-MM, VAT blank unless the practice is VAT registered", () => {
    const rows = [{ month: "2030-01-01", invoices: 2, invoicedCents: 123450, vatCents: 16102, receivedCents: 50000, creditCents: 1150 }];
    expect(incomeByMonthCsv(rows, true)).toEqual([{ month: "2030-01", invoices: 2, invoiced_zar: 1234.5, vat_zar: 161.02, received_zar: 500, credit_notes_zar: 11.5 }]);
    expect(incomeByMonthCsv(rows, false)[0].vat_zar).toBeNull();
    expect(toCsv(incomeByMonthCsv(rows, true), EXPORT_COLUMNS.income_by_month)).toBe("month,invoices,invoiced_zar,vat_zar,received_zar,credit_notes_zar\n2030-01,2,1234.5,161.02,500,11.5");
  });
  it("transactions: credit notes are negative numbers (not turned into text), no patient column", () => {
    const csv = toCsv(transactionsCsv([
      { date: "2030-03-01", kind: "payment", invoiceNumber: "INV-00001", method: "eft", reference: "BANK-1", portion: "patient", amountCents: 5750, vatCents: 750 },
      { date: "2030-03-02", kind: "credit_note", invoiceNumber: "INV-00001", method: "credit_note", reference: null, portion: "patient", amountCents: -1150, vatCents: -150 },
    ]), EXPORT_COLUMNS.transactions);
    expect(csv).toBe([
      "date,type,invoice_number,method,reference,portion,amount_zar,vat_zar",
      "2030-03-01,payment,INV-00001,eft,BANK-1,patient,57.5,7.5",
      "2030-03-02,credit note,INV-00001,credit_note,,patient,-11.5,-1.5",
    ].join("\n"));
  });
  it("a reference or session type that looks like a formula is neutralised", () => {
    const t = toCsv(transactionsCsv([{ date: "2030-03-01", kind: "payment", invoiceNumber: "INV-1", method: "eft", reference: "=HYPERLINK(\"http://x\")", portion: "patient", amountCents: 1, vatCents: null }]), EXPORT_COLUMNS.transactions);
    expect(t.split("\n")[1]).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
  });
  it("debtors: the as-of date, the age wording, and never the patient id", () => {
    const rows = debtorsCsv([{ invoiceNumber: "INV-00007", dueDate: "2030-02-01", daysOverdue: 12, bucket: "1-30", payerType: "split", outstandingCents: 15000, schemeCents: 10000, patientCents: 5000, patientId: "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d" }], "2030-02-13");
    expect(rows[0]).toEqual({ as_of: "2030-02-13", invoice_number: "INV-00007", due_date: "2030-02-01", days_overdue: 12, age_bucket: "1 to 30 days overdue", payer: "split", outstanding_zar: 150, scheme_zar: 100, patient_zar: 50 });
    expect(JSON.stringify(rows)).not.toContain("9a1b2c3d");
  });
  it("appointments: rates are percent with one decimal, NULL stays blank", () => {
    const r = appointmentsCsv([{ sessionType: "All session types", isTotal: true, booked: 6, attended: 4, noShow: 1, cancelled: 3, lateCancelled: 1, bookedMinutes: 340, availableMinutes: null, utilisation: null, noShowRate: 0.2, cancellationRate: 0.3333 }]);
    expect(r[0]).toMatchObject({ available_minutes: null, utilisation_pct: null, no_show_rate_pct: 20, cancellation_rate_pct: 33.3 });
  });
});

describe("shaping the flat tables", () => {
  const rows: FlatRow[] = [
    { section: "new_patients", label: "2030-02", detail: null, n: 1 }, { section: "new_patients", label: "2030-01", detail: null, n: 2 },
    { section: "referral", label: "Facebook", detail: null, n: 1 }, { section: "referral", label: "GP", detail: null, n: 2 }, { section: "referral", label: "Not recorded", detail: null, n: 2 },
    { section: "caseload", label: "active", detail: null, n: 5 }, { section: "tasks", label: "created", detail: null, n: 4 }, { section: "tasks", label: "completed", detail: null, n: 3 },
    { section: "claims", label: "rejected", detail: null, n: 1 }, { section: "claims", label: "draft", detail: null, n: 2 }, { section: "payfast_open", label: "open", detail: null, n: 2 },
  ];
  it("practice activity: months ascending, referrals by count then name, completion rate", () => {
    const a = shapeActivity(rows);
    expect(a.newPatients).toEqual([{ month: "2030-01", n: 2 }, { month: "2030-02", n: 1 }]);
    expect(a.referrals.map((r) => r.label)).toEqual(["GP", "Not recorded", "Facebook"]);
    expect(a).toMatchObject({ caseload: 5, tasksCreated: 4, tasksCompleted: 3, completionRate: 0.75, payfastOpen: 2 });
    expect(a.claims).toEqual([{ status: "draft", n: 2 }, { status: "rejected", n: 1 }]);
  });
  it("practice activity: no tasks means no rate (n/a), not zero", () => {
    expect(shapeActivity([]).completionRate).toBeNull();
    expect(activityCsv(shapeActivity([])).find((r) => r.item === "Completion rate (%)")?.value).toBeNull();
  });
  it("compliance: every activity key and every purpose is present even with no rows", () => {
    const c = shapeCompliance([]);
    expect(c.activity).toHaveLength(9);
    expect(c.consent).toHaveLength(6);
    expect(c.activity.every((a) => a.n === 0)).toBe(true);
    expect(complianceCsv(c)).toHaveLength(9 + 18 + 2);
  });
  it("compliance: consent statuses are matched by purpose and status", () => {
    const c = shapeCompliance([
      { section: "consent", label: "treatment", detail: "granted", n: 7 }, { section: "consent", label: "treatment", detail: "withdrawn", n: 1 }, { section: "consent", label: "treatment", detail: "none", n: 2 },
      { section: "activity", label: "logins", detail: null, n: 9 }, { section: "failed_notifications", label: "failed", detail: null, n: 3 }, { section: "payfast_rejected", label: "rejected", detail: null, n: 4 },
    ]);
    expect(c.consent[0]).toEqual({ purpose: "treatment", granted: 7, withdrawn: 1, none: 2 });
    expect(c.activity[0]).toEqual({ key: "logins", n: 9 });
    expect(c).toMatchObject({ failedNotifications: 3, payfastRejected: 4 });
  });
});

describe("fetching", () => {
  it("bigint strings become numbers, nulls stay null, and the call sends p_from / p_to exactly as the SQL names them", async () => {
    const { sb, calls } = fake({ report_income_by_month: [{ month_start: "2030-01-01", invoices_n: "2", invoiced_cents: "123450", vat_cents: "0", received_cents: 5, credit_cents: null }] });
    expect(await fetchIncomeByMonth(sb, { from: "2030-01-01", to: "2030-03-31" })).toEqual([{ month: "2030-01-01", invoices: 2, invoicedCents: 123450, vatCents: 0, receivedCents: 5, creditCents: 0 }]);
    expect(calls).toEqual([{ fn: "report_income_by_month", args: { p_from: "2030-01-01", p_to: "2030-03-31" } }]);
  });
  it("an error becomes a ReportQueryError carrying a code and never the message text", async () => {
    const { sb } = fake({}, { code: "P0001", message: "secret value in message" });
    const err = await exportRows(sb, "income_by_method", { from: "2030-01-01", to: "2030-03-31" }, { vatRegistered: false, asOf: "2030-03-31" }).catch((e) => e);
    expect(err).toBeInstanceOf(ReportQueryError);
    expect(err.message).toBe("report_query_failed:P0001");
    expect(err.reason).toBe("failed");
  });
  it("too_many_rows is recognised so the route can explain it", async () => {
    const { sb } = fake({}, { code: "P0001", message: "too_many_rows" });
    const err = await exportRows(sb, "transactions", { from: "2030-01-01", to: "2030-03-31" }, { vatRegistered: false, asOf: "2030-03-31" }).catch((e) => e);
    expect(err.reason).toBe("too_many_rows");
  });
  it("debtors are read as at the given date, with the single p_as_of the SQL expects", async () => {
    const { sb, calls } = fake({ report_debtors_detail: [] });
    await exportRows(sb, "debtors", { from: "2030-01-01", to: "2030-03-31" }, { vatRegistered: false, asOf: "2030-03-15" });
    expect(calls).toEqual([{ fn: "report_debtors_detail", args: { p_as_of: "2030-03-15" } }]);
  });
});
