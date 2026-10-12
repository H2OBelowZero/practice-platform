import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { called, type Query, type Result } from "../stubs/fake-supabase";

// /app/reports rendered with a fake "RLS-filtered" client: whatever the resolver returns is what the signed-in user may read.
// 2031-03-10T07:30:00Z is 09:30 SAST on Monday 10 March 2031, so the default period (last 3 months) is 2031-01-01 to 2031-03-10.
const h = vi.hoisted(() => ({ role: "psychologist", resolve: (() => ({})) as (q: Query) => Result, log: [] as Query[] }));
vi.mock("@/lib/auth/session", () => ({
  requireRole: async (allowed: string[]) => { if (!allowed.includes(h.role)) throw new Error("NOT_FOUND"); return { userId: "me", role: h.role }; },
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => (await import("../stubs/fake-supabase")).fakeSupabase((q) => h.resolve(q), h.log) }));

import ReportsPage from "@/app/app/reports/page";

const P1 = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", P2 = "11111111-2222-4333-8444-555555555555";
const rpcArgs = (q: Query) => q.calls.find((c) => c.m === "rpc")?.a[0] as Record<string, string>;
const rpcNames = () => h.log.filter((q) => q.table.startsWith("rpc:")).map((q) => q.table.slice(4));
const tables = () => h.log.filter((q) => !q.table.startsWith("rpc:")).map((q) => q.table);

const month = (m: string, o: Record<string, number> = {}) => ({ month_start: m, invoices_n: 0, invoiced_cents: 0, vat_cents: 0, vat_credited_cents: 0, received_cents: 0, credit_cents: 0, ...o });
const data: Record<string, unknown> = {
  report_income_by_month: [
    month("2031-01-01", { invoices_n: 2, invoiced_cents: 300000, vat_cents: 39130, vat_credited_cents: 652, received_cents: 150000, credit_cents: 5000 }),
    month("2031-02-01", { invoices_n: 1, invoiced_cents: 100000, vat_cents: 13043, received_cents: 250000 }),
    month("2031-03-01"),
  ],
  report_income_by_method: [
    { method: "payfast", payments_n: 0, received_cents: 0 }, { method: "eft", payments_n: "3", received_cents: "300000" }, { method: "cash", payments_n: 1, received_cents: 100000 },
    { method: "card_machine", payments_n: 0, received_cents: 0 }, { method: "medical_aid", payments_n: 0, received_cents: 0 },
  ],
  report_income_by_session_type: [{ session_type: "Individual session", invoices_n: 3, invoiced_cents: 285000 }, { session_type: "Other / manual", invoices_n: 1, invoiced_cents: 15000 }],
  report_debtors_ageing: [
    { bucket: "current", invoices_n: 1, outstanding_cents: 10000, scheme_cents: 0, patient_cents: 10000 }, { bucket: "1-30", invoices_n: 1, outstanding_cents: 15000, scheme_cents: 10000, patient_cents: 5000 },
    { bucket: "31-60", invoices_n: 0, outstanding_cents: 0, scheme_cents: 0, patient_cents: 0 }, { bucket: "61-90", invoices_n: 0, outstanding_cents: 0, scheme_cents: 0, patient_cents: 0 },
    { bucket: "90+", invoices_n: 0, outstanding_cents: 0, scheme_cents: 0, patient_cents: 0 },
  ],
  report_debtors_detail: [
    { invoice_number: "INV-00007", due_date: "2031-02-20", days_overdue: 18, bucket: "1-30", payer_type: "split", outstanding_cents: 15000, scheme_cents: 10000, patient_cents: 5000, patient_id: P1 },
    { invoice_number: "INV-00009", due_date: "2031-03-20", days_overdue: 0, bucket: "current", payer_type: "self", outstanding_cents: 10000, scheme_cents: 0, patient_cents: 10000, patient_id: P2 },
  ],
  report_appointments: [
    { session_type: "Individual session", is_total: false, booked: 5, attended: 3, no_show: 1, cancelled: 3, late_cancelled: 1, booked_minutes: 250, available_minutes: null, utilisation: null, no_show_rate: "0.2500", cancellation_rate: "0.3750" },
    { session_type: "All session types", is_total: true, booked: 5, attended: 3, no_show: 1, cancelled: 3, late_cancelled: 1, booked_minutes: 250, available_minutes: 1290, utilisation: "0.1938", no_show_rate: "0.2500", cancellation_rate: "0.3750" },
  ],
  report_practice_activity: [
    { section: "new_patients", label: "2031-01", detail: null, n: 2 }, { section: "new_patients", label: "2031-02", detail: null, n: 0 }, { section: "new_patients", label: "2031-03", detail: null, n: 1 },
    { section: "referral", label: "GP", detail: null, n: 2 }, { section: "referral", label: "Not recorded", detail: null, n: 1 },
    { section: "caseload", label: "active", detail: null, n: 12 }, { section: "tasks", label: "created", detail: null, n: 8 }, { section: "tasks", label: "completed", detail: null, n: 6 },
    { section: "claims", label: "rejected", detail: null, n: 1 }, { section: "payfast_open", label: "open", detail: null, n: 2 },
  ],
  report_compliance: [
    ...["logins", "patient_views", "note_views", "claim_views", "exports", "settings_changes", "consent_grants", "consent_withdrawals", "note_addenda"].map((l, i) => ({ section: "activity", label: l, detail: null, n: i + 1 })),
    { section: "consent", label: "treatment", detail: "granted", n: 7 }, { section: "consent", label: "treatment", detail: "withdrawn", n: 1 }, { section: "consent", label: "treatment", detail: "none", n: 2 },
    { section: "failed_notifications", label: "failed", detail: null, n: 3 }, { section: "payfast_rejected", label: "rejected", detail: null, n: 4 },
  ],
};
let vat = false;
const base = (q: Query): Result => {
  if (q.table.startsWith("rpc:")) return { data: data[q.table.slice(4)] ?? [] };
  if (q.table === "practices") return { data: { vat_registered: vat } };
  if (q.table === "patients") return { data: [{ id: P1, first_name: "Thandi", last_name: "Nkosi" }, { id: P2, first_name: "Sipho", last_name: "Dlamini" }] };
  return {};
};
const render = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await ReportsPage({ searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-03-10T07:30:00Z"));
  h.role = "psychologist"; h.resolve = base; h.log.length = 0; vat = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("/app/reports: Financial", () => {
  it("defaults to the last 3 months in SAST and calls only the financial report functions with exactly the SQL parameter names", async () => {
    await render();
    const ranged = ["report_income_by_month", "report_income_by_method", "report_income_by_session_type"];
    for (const n of ranged) expect(rpcArgs(h.log.find((q) => q.table === `rpc:${n}`)!)).toEqual({ p_from: "2031-01-01", p_to: "2031-03-10" });
    for (const n of ["report_debtors_ageing", "report_debtors_detail"]) expect(rpcArgs(h.log.find((q) => q.table === `rpc:${n}`)!)).toEqual({ p_as_of: "2031-03-10" });
    expect(rpcNames().sort()).toEqual([...ranged, "report_debtors_ageing", "report_debtors_detail"].sort());
  });

  it("shows the tables with a caption, scoped headers, right-aligned tabular numbers, rand amounts and month labels", async () => {
    const out = await render();
    expect(out).toContain("<h1>Reports</h1>");
    expect(out).toContain('<caption class="sr-only">Income by month</caption>');
    expect(out).toContain('scope="col"');
    expect(out).toContain('scope="row"');
    expect(out).toContain("Jan 2031");
    expect(out).toContain("R 3 000,00"); // January invoiced
    expect(out).toContain("R 4 000,00"); // invoiced total (3000 + 1000)
    expect(out).toContain("R 4 000,00");
    expect(out).toMatch(/class="[^"]*text-right tabular-nums[^"]*"/);
    expect(out).toContain("EFT");
    expect(out).toContain("Individual session");
    expect(out).toContain("Other / manual");
    expect(out).toContain("Not yet due");
    expect(out).toContain("1 to 30 days overdue");
  });

  it("puts a plain-language definition under every section", async () => {
    const out = await render();
    expect(out).toContain("Invoiced = the total of invoices issued in that month, excluding drafts and invoices you voided by hand");
    expect(out).toContain("Debtors are invoices that were issued and are not yet fully settled");
    expect((out.match(/What this means\. /g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(out).toContain("Clinical outcome analytics are not part of this release");
  });

  it("small bars are decorative (aria-hidden) and sized from the data", async () => {
    const out = await render();
    expect(out).toMatch(/<span aria-hidden="true" class="[^"]*"><span class="[^"]*" style="width:100%">/);
    expect(out).toMatch(/style="width:33%"/); // 100000 of 300000
  });

  it("the VAT column is there only when the practice is VAT registered", async () => {
    expect(await render()).not.toMatch(/scope="col"[^>]*>VAT included</);
    vat = true;
    const out = await render();
    expect(out).toMatch(/scope="col"[^>]*>VAT included</);
    expect(out).toContain("R 391,30");
    expect(out).toMatch(/scope="col"[^>]*>VAT on credit notes</);
    expect(out).toContain("R 6,52");
  });

  it("every CSV control is a plain download anchor to the export route with the dates on screen, and the accountant export is explained", async () => {
    const out = await render();
    const anchors = [...out.matchAll(/<a [^>]*href="\/app\/reports\/export[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(anchors).toHaveLength(5);
    for (const a of anchors) expect(a).toContain(" download");
    for (const k of ["income_by_month", "income_by_method", "income_by_session_type", "debtors", "transactions"]) expect(out).toContain(`href="/app/reports/export?report=${k}&amp;from=2031-01-01&amp;to=2031-03-10"`);
    expect(out).toContain("Accountant export");
    expect(out).toContain("It has no patient names");
    expect(out).toContain("can contain a payer&#x27;s name");
  });

  it("psychologist and admin see debtor names (read through the user's own client, ids only from the report); each links to the patient's billing", async () => {
    for (const role of ["psychologist", "admin"]) {
      h.role = role; h.log.length = 0;
      const out = await render();
      expect(out).toContain("Thandi Nkosi");
      expect(out).toContain(`href="/app/patients/${P1}?tab=billing"`);
      const q = h.log.find((x) => x.table === "patients")!;
      expect(called(q, "select", "id, first_name, last_name")).toBe(true);
      expect(called(q, "in", "id", [P1, P2])).toBe(true);
      expect(called(q, "select", "*")).toBe(false);
    }
  });

  it("the bookkeeper gets the Financial report with amounts and invoice numbers, never a patient name, id or lookup", async () => {
    h.role = "bookkeeper";
    h.resolve = (q) => (q.table === "rpc:report_debtors_detail" ? { data: (data.report_debtors_detail as Record<string, unknown>[]).map((r) => ({ ...r, patient_id: null })) } : base(q));
    const out = await render();
    expect(tables()).not.toContain("patients");
    expect(out).not.toContain("Thandi");
    expect(out).not.toContain("Nkosi");
    expect(out).not.toContain(P1);
    expect(out).not.toContain("/app/patients/");
    expect(out).not.toMatch(/scope="col"[^>]*>Patient</);
    expect(out).toContain("INV-00007");
    expect(out).toContain("R 150,00");
  });

  it("debtor names that cannot be loaded say so instead of showing blanks", async () => {
    h.resolve = (q) => (q.table === "patients" ? { error: { code: "42501" } } : base(q));
    const out = await render();
    expect(out).toContain("Patient names could not be loaded just now");
    expect(out).toContain("Name unavailable");
  });

  it("a section whose query fails shows a quiet note and the others still render; only a code is logged", async () => {
    h.resolve = (q) => (q.table === "rpc:report_income_by_method" ? { error: { code: "P0001", message: "secret detail" } } : base(q));
    const out = await render();
    expect(out).toContain("We couldn&#x27;t load this report just now");
    expect(out).toContain("Individual session");
    expect(out).toContain('<caption class="sr-only">Income by month</caption>');
    expect(out).not.toContain("secret detail");
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join(" ");
    expect(logged).toContain("report_query_failed:P0001");
    expect(logged).not.toContain("secret detail");
  });

  it("empty periods say so", async () => {
    h.resolve = (q) => (q.table.startsWith("rpc:") ? { data: [] } : base(q));
    const out = await render();
    expect(out).toContain("No invoices, payments or credit notes in this period.");
    expect(out).toContain("Nothing is outstanding.");
    expect(out).toContain("There are no open invoices.");
  });

  it("text from the database is escaped", async () => {
    h.resolve = (q) => q.table === "rpc:report_income_by_session_type" ? { data: [{ session_type: "<script>alert(1)</script>", invoices_n: 1, invoiced_cents: 100 }] }
      : q.table === "patients" ? { data: [{ id: P1, first_name: "<img src=x onerror=alert(1)>", last_name: "Z" }] } : base(q);
    const out = await render();
    expect(out).not.toContain("<script>alert(1)");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).not.toContain("<img src=x");
  });
});

describe("/app/reports: debtors for an old period", () => {
  it("a period that ended more than 800 days ago explains instead of failing, and does not ask the database for debtors", async () => {
    const out = await render({ preset: "custom", from: "2027-01-01", to: "2028-12-01" });
    expect(out).toContain("Debtors can only be shown as at a date within the last 800 days");
    expect(out).not.toContain("We couldn&#x27;t load this report just now");
    expect(rpcNames()).not.toContain("report_debtors_ageing");
    expect(rpcNames()).not.toContain("report_debtors_detail");
    expect(rpcNames()).toContain("report_income_by_month");
  });
  it("the definitions say what the owner needs to know", async () => {
    const out = await render();
    expect(out).toContain("they include invoices that were paid or credited off later");
    expect(out).toContain("cancelled by credit notes");
    expect(out).toContain("still counts in the month it was issued");
    h.role = "admin";
    const appt = await render({ report: "appointments" });
    expect(appt).toContain("Working hours that overlap each other are counted separately");
    expect(appt).toContain("over 100%");
    expect(appt).toContain("even for older sessions");
    expect(appt).toContain("cancellations made by the practice as well as by the patient");
    expect(await render()).toContain("adds up to the invoice&#x27;s VAT to the cent");
  });
});

describe("/app/reports: period controls", () => {
  it("lists the presets as links, marks the current one, and has a custom from/to form with native date inputs", async () => {
    const out = await render({ preset: "this_month" });
    for (const t of ["This month", "Last month", "Last 3 months", "This year"]) expect(out).toContain(t);
    const tag = /<a [^>]*>This month<[/]a>/.exec(out)?.[0] ?? "";
    expect(tag).toContain('href="/app/reports?report=financial&amp;preset=this_month"');
    expect(tag).toContain('aria-current="true"');
    expect(/<a [^>]*>Last month<[/]a>/.exec(out)?.[0]).not.toContain("aria-current");
    expect(out).toContain('type="date"');
    expect(out).toContain('name="from"');
    expect(out).toContain('name="to"');
    expect(out).toContain('<input type="hidden" name="preset" value="custom"/>');
    expect(rpcArgs(h.log.find((q) => q.table === "rpc:report_income_by_month")!)).toEqual({ p_from: "2031-03-01", p_to: "2031-03-10" });
  });

  it("custom dates reach the database exactly as typed, and the export links carry them", async () => {
    const out = await render({ preset: "custom", from: "2031-02-10", to: "2031-02-20" });
    expect(rpcArgs(h.log.find((q) => q.table === "rpc:report_income_by_month")!)).toEqual({ p_from: "2031-02-10", p_to: "2031-02-20" });
    expect(rpcArgs(h.log.find((q) => q.table === "rpc:report_debtors_ageing")!)).toEqual({ p_as_of: "2031-02-20" });
    expect(out).toContain("report=income_by_month&amp;from=2031-02-10&amp;to=2031-02-20");
    expect(out).toContain('value="2031-02-10"');
  });

  it("unusable custom dates are refused with a plain message and the default period is used", async () => {
    for (const sp of [{ preset: "custom", from: "2031-03-10", to: "2031-01-01" }, { preset: "custom", from: "2031-02-31", to: "2031-03-01" }, { preset: "custom", from: "2031-03-01" }] as Record<string, string>[]) {
      h.log.length = 0;
      const out = await render(sp);
      expect(out).toContain("Those dates could not be used");
      expect(out).toContain("Showing the last 3 months instead.");
      expect(rpcArgs(h.log.find((q) => q.table === "rpc:report_income_by_month")!)).toEqual({ p_from: "2031-01-01", p_to: "2031-03-10" });
    }
  });
});

describe("/app/reports: tabs and role gates", () => {
  const tabLabels = (out: string) => [...out.matchAll(/<nav aria-label="Report type"[\s\S]*?<\/nav>/g)].flatMap((m) => [...m[0].matchAll(/>([^<]+)<\/a>/g)].map((x) => x[1]));
  it("psychologist: four tabs; the current one is marked", async () => {
    const out = await render();
    expect(tabLabels(out)).toEqual(["Financial", "Appointments", "Practice activity", "Compliance"]);
    expect(out).toMatch(/aria-current="page"[^>]*>Financial</);
  });
  it("admin: no Compliance tab, and asking for it shows Financial without calling the compliance report", async () => {
    h.role = "admin";
    const out = await render({ report: "compliance" });
    expect(tabLabels(out)).toEqual(["Financial", "Appointments", "Practice activity"]);
    expect(rpcNames()).not.toContain("report_compliance");
    expect(out).toContain('<caption class="sr-only">Income by month</caption>');
  });
  it("bookkeeper: Financial only, and asking for any other tab never calls its report", async () => {
    h.role = "bookkeeper";
    for (const report of ["appointments", "activity", "compliance"]) {
      h.log.length = 0;
      const out = await render({ report });
      expect(tabLabels(out)).toEqual(["Financial"]);
      expect(rpcNames().every((n) => /^report_(income|debtors)/.test(n))).toBe(true);
      expect(out).not.toContain("Utilisation");
    }
  });
  it("associate, patient and guardian get a 404", async () => {
    for (const role of ["associate", "patient", "guardian"]) { h.role = role; await expect(render()).rejects.toThrow("NOT_FOUND"); }
    expect(h.log).toHaveLength(0);
  });
});

describe("/app/reports: Appointments", () => {
  beforeEach(() => { h.role = "admin"; });
  it("calls only report_appointments with the period", async () => {
    await render({ report: "appointments" });
    expect(rpcNames()).toEqual(["report_appointments"]);
    expect(rpcArgs(h.log[0])).toEqual({ p_from: "2031-01-01", p_to: "2031-03-10" });
  });
  it("shows the figures with one-decimal percentages, and the definition says attendance is not retention or outcomes", async () => {
    const out = await render({ report: "appointments" });
    expect(out).toContain("19.4%"); // utilisation 0.1938
    expect(out).toContain("25.0%"); // no-show rate
    expect(out).toContain("37.5%"); // cancellation rate
    expect(out).toContain("4 h 10 min booked of 21 h 30 min available");
    expect(out).toContain("1 of them late");
    expect(out).toContain("They are not a measure of patient retention, engagement or outcomes.");
    expect(out).toContain('<caption class="sr-only">Appointments by session type</caption>');
    expect(out).toContain("All session types");
  });
  it("utilisation is n/a with a reason when no working hours are set", async () => {
    h.resolve = (q) => q.table === "rpc:report_appointments" ? { data: [{ ...(data.report_appointments as Record<string, unknown>[])[1], available_minutes: null, utilisation: null }] } : base(q);
    const out = await render({ report: "appointments" });
    expect(out).toContain("n/a");
    expect(out).toContain("No working hours are set for this period.");
  });
  it("an empty period says so", async () => {
    h.resolve = (q) => q.table === "rpc:report_appointments" ? { data: [{ session_type: "All session types", is_total: true, booked: 0, attended: 0, no_show: 0, cancelled: 0, late_cancelled: 0, booked_minutes: 0, available_minutes: null, utilisation: null, no_show_rate: null, cancellation_rate: null }] } : base(q);
    expect(await render({ report: "appointments" })).toContain("There were no sessions in this period.");
  });
});

describe("/app/reports: Practice activity", () => {
  it("shows new patients, referral sources, caseload, task completion, claims and unmatched PayFast; says there is no waiting list", async () => {
    h.role = "admin";
    const out = await render({ report: "activity" });
    expect(rpcNames()).toEqual(["report_practice_activity"]);
    expect(out).toContain("Jan 2031");
    expect(out).toContain("Referral source");
    expect(out).toContain("Not recorded");
    expect(out).toContain("75.0%"); // 6 of 8
    expect(out).toContain("6 of 8 created in the period");
    expect(out).toContain("Rejected"); // claim status label
    expect(out).toContain('href="/app/tasks?group=payfast"');
    expect(out).toContain("There is no waiting list in the system yet");
  });
});

describe("/app/reports: Compliance", () => {
  it("is the psychologist's: system-activity wording, counts and consent, with no row-level identity", async () => {
    const out = await render({ report: "compliance" });
    expect(rpcNames()).toEqual(["report_compliance"]);
    expect(out).toContain("These figures describe system activity, not clinical outcomes.");
    expect(out).toContain("Sign-ins");
    expect(out).toContain("Patient records opened");
    expect(out).toContain("Treatment");
    expect(out).toContain("Notifications that failed to send");
    expect(out).toContain("PayFast notifications refused");
    expect(tables()).toEqual([]); // nothing but the report function was read
  });
});
