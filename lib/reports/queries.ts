import type { SupabaseClient } from "@supabase/supabase-js";
import { CONSENT_PURPOSES } from "@/lib/forms/validate";

// The report_* database functions (0025) and what they return, as plain numbers and strings. Every function runs as the signed-in user (RLS applies); this file
// never uses the service client. bigint columns arrive as strings or numbers depending on the driver, so every number goes through num().

export class ReportQueryError extends Error {
  constructor(readonly code: string, readonly reason: "too_many_rows" | "failed") { super(`report_query_failed:${code}`); }
}

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v ?? 0);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => String(v ?? "");

/** Call a report function and return its rows; the error message is reduced to a code (it may echo a value), except the one case the CSV route explains to the person. */
export async function rpcRows(sb: SupabaseClient, fn: string, args: Record<string, string>): Promise<Row[]> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new ReportQueryError(error.code ?? "", /too_many_rows/.test(error.message ?? "") ? "too_many_rows" : "failed");
  return (data ?? []) as Row[];
}

type Range = { from: string; to: string };
const range = (r: Range) => ({ p_from: r.from, p_to: r.to });

// ---- financial ---------------------------------------------------------------------------------------------------------------------------
export type IncomeMonth = { month: string; invoices: number; invoicedCents: number; vatCents: number; receivedCents: number; creditCents: number };
export const fetchIncomeByMonth = async (sb: SupabaseClient, r: Range): Promise<IncomeMonth[]> =>
  (await rpcRows(sb, "report_income_by_month", range(r))).map((x) => ({
    month: str(x.month_start), invoices: num(x.invoices_n), invoicedCents: num(x.invoiced_cents), vatCents: num(x.vat_cents), receivedCents: num(x.received_cents), creditCents: num(x.credit_cents),
  }));

export type MethodRow = { method: string; payments: number; receivedCents: number };
export const fetchIncomeByMethod = async (sb: SupabaseClient, r: Range): Promise<MethodRow[]> =>
  (await rpcRows(sb, "report_income_by_method", range(r))).map((x) => ({ method: str(x.method), payments: num(x.payments_n), receivedCents: num(x.received_cents) }));

export type SessionTypeRow = { sessionType: string; invoices: number; invoicedCents: number };
export const fetchIncomeBySessionType = async (sb: SupabaseClient, r: Range): Promise<SessionTypeRow[]> =>
  (await rpcRows(sb, "report_income_by_session_type", range(r))).map((x) => ({ sessionType: str(x.session_type), invoices: num(x.invoices_n), invoicedCents: num(x.invoiced_cents) }));

export type AgeingRow = { bucket: string; invoices: number; outstandingCents: number; schemeCents: number; patientCents: number };
export const fetchAgeing = async (sb: SupabaseClient, asOf: string): Promise<AgeingRow[]> =>
  (await rpcRows(sb, "report_debtors_ageing", { p_as_of: asOf })).map((x) => ({
    bucket: str(x.bucket), invoices: num(x.invoices_n), outstandingCents: num(x.outstanding_cents), schemeCents: num(x.scheme_cents), patientCents: num(x.patient_cents),
  }));

export type DebtorRow = {
  invoiceNumber: string; dueDate: string; daysOverdue: number; bucket: string; payerType: string; outstandingCents: number; schemeCents: number; patientCents: number; patientId: string | null;
};
export const fetchDebtors = async (sb: SupabaseClient, asOf: string): Promise<DebtorRow[]> =>
  (await rpcRows(sb, "report_debtors_detail", { p_as_of: asOf })).map((x) => ({
    invoiceNumber: str(x.invoice_number), dueDate: str(x.due_date), daysOverdue: num(x.days_overdue), bucket: str(x.bucket), payerType: str(x.payer_type),
    outstandingCents: num(x.outstanding_cents), schemeCents: num(x.scheme_cents), patientCents: num(x.patient_cents), patientId: x.patient_id ? str(x.patient_id) : null,
  }));

export type TransactionRow = { date: string; kind: string; invoiceNumber: string; method: string; reference: string | null; portion: string; amountCents: number; vatCents: number | null };
export const fetchTransactions = async (sb: SupabaseClient, r: Range): Promise<TransactionRow[]> =>
  (await rpcRows(sb, "report_transactions", range(r))).map((x) => ({
    date: str(x.txn_date), kind: str(x.kind), invoiceNumber: str(x.invoice_number), method: str(x.method), reference: x.reference === null || x.reference === undefined ? null : str(x.reference),
    portion: str(x.portion), amountCents: num(x.amount_cents), vatCents: numOrNull(x.vat_cents),
  }));

// ---- appointments ------------------------------------------------------------------------------------------------------------------------
export type AppointmentRow = {
  sessionType: string; isTotal: boolean; booked: number; attended: number; noShow: number; cancelled: number; lateCancelled: number; bookedMinutes: number;
  availableMinutes: number | null; utilisation: number | null; noShowRate: number | null; cancellationRate: number | null;
};
export const fetchAppointments = async (sb: SupabaseClient, r: Range): Promise<AppointmentRow[]> =>
  (await rpcRows(sb, "report_appointments", range(r))).map((x) => ({
    sessionType: str(x.session_type), isTotal: x.is_total === true, booked: num(x.booked), attended: num(x.attended), noShow: num(x.no_show), cancelled: num(x.cancelled),
    lateCancelled: num(x.late_cancelled), bookedMinutes: num(x.booked_minutes), availableMinutes: numOrNull(x.available_minutes), utilisation: numOrNull(x.utilisation),
    noShowRate: numOrNull(x.no_show_rate), cancellationRate: numOrNull(x.cancellation_rate),
  }));

// ---- practice activity and compliance (flat section/label/detail/n tables) ----------------------------------------------------------------
export type FlatRow = { section: string; label: string; detail: string | null; n: number };
const flat = async (sb: SupabaseClient, fn: string, r: Range): Promise<FlatRow[]> =>
  (await rpcRows(sb, fn, range(r))).map((x) => ({ section: str(x.section), label: str(x.label), detail: x.detail === null || x.detail === undefined ? null : str(x.detail), n: num(x.n) }));

export type Activity = {
  newPatients: { month: string; n: number }[]; referrals: { label: string; n: number }[]; caseload: number;
  tasksCreated: number; tasksCompleted: number; completionRate: number | null; claims: { status: string; n: number }[]; payfastOpen: number;
};
export function shapeActivity(rows: FlatRow[]): Activity {
  const of = (s: string) => rows.filter((r) => r.section === s);
  const one = (s: string, label: string) => of(s).find((r) => r.label === label)?.n ?? 0;
  const created = one("tasks", "created"), completed = one("tasks", "completed");
  return {
    newPatients: of("new_patients").map((r) => ({ month: r.label, n: r.n })).sort((a, b) => a.month.localeCompare(b.month)),
    referrals: of("referral").map((r) => ({ label: r.label, n: r.n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
    caseload: one("caseload", "active"), tasksCreated: created, tasksCompleted: completed, completionRate: created > 0 ? completed / created : null,
    claims: of("claims").map((r) => ({ status: r.label, n: r.n })).sort((a, b) => b.n - a.n || a.status.localeCompare(b.status)), payfastOpen: one("payfast_open", "open"),
  };
}
export const fetchActivity = async (sb: SupabaseClient, r: Range): Promise<Activity> => shapeActivity(await flat(sb, "report_practice_activity", r));

export const ACTIVITY_KEYS = ["logins", "patient_views", "note_views", "claim_views", "exports", "settings_changes", "consent_grants", "consent_withdrawals", "note_addenda"] as const;
export type Compliance = {
  activity: { key: string; n: number }[]; consent: { purpose: string; granted: number; withdrawn: number; none: number }[]; failedNotifications: number; payfastRejected: number;
};
export function shapeCompliance(rows: FlatRow[]): Compliance {
  const of = (s: string) => rows.filter((r) => r.section === s);
  const act = new Map(of("activity").map((r) => [r.label, r.n]));
  const consent = of("consent");
  const at = (p: string, st: string) => consent.find((r) => r.label === p && r.detail === st)?.n ?? 0;
  return {
    activity: ACTIVITY_KEYS.map((key) => ({ key, n: act.get(key) ?? 0 })),
    consent: CONSENT_PURPOSES.map((purpose) => ({ purpose, granted: at(purpose, "granted"), withdrawn: at(purpose, "withdrawn"), none: at(purpose, "none") })),
    failedNotifications: of("failed_notifications")[0]?.n ?? 0, payfastRejected: of("payfast_rejected")[0]?.n ?? 0,
  };
}
export const fetchCompliance = async (sb: SupabaseClient, r: Range): Promise<Compliance> => shapeCompliance(await flat(sb, "report_compliance", r));
