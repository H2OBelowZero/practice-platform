import type { SupabaseClient } from "@supabase/supabase-js";
import { AGEING_LABEL, type AgeingBucket } from "./ageing";
import type { CsvCell } from "./csv";
import { percentNumber, zar } from "./format";
import { ACTIVITY_LABEL, claimStatusLabel, consentLabel } from "./labels";
import type { ExportKey } from "./keys";
import {
  fetchActivity, fetchAppointments, fetchCompliance, fetchDebtors, fetchIncomeByMethod, fetchIncomeByMonth, fetchIncomeBySessionType, fetchTransactions,
  type Activity, type AppointmentRow, type Compliance, type DebtorRow, type IncomeMonth, type MethodRow, type SessionTypeRow, type TransactionRow,
} from "./queries";

// The CSV of each report: a fixed list of column names (the header never changes with the data, an empty export still has it) and the mapping from the typed
// rows. Money is a plain number of rand; rates are percent with one decimal; nothing here names a patient. toCsv neutralises every text cell.

export type CsvRow = Record<string, CsvCell>;

export const EXPORT_COLUMNS: Record<ExportKey, string[]> = {
  income_by_month: ["month", "invoices", "invoiced_zar", "vat_zar", "vat_credited_zar", "received_zar", "credit_notes_zar"],
  income_by_method: ["method", "payments", "received_zar"],
  income_by_session_type: ["session_type", "invoices", "invoiced_zar"],
  debtors: ["as_of", "invoice_number", "due_date", "days_overdue", "age_bucket", "payer", "outstanding_zar", "scheme_zar", "patient_zar"],
  appointments: ["session_type", "booked", "attended", "no_show", "cancelled", "late_cancelled", "booked_minutes", "available_minutes", "utilisation_pct", "no_show_rate_pct", "cancellation_rate_pct"],
  activity: ["section", "item", "value"],
  compliance: ["section", "item", "status", "count"],
  transactions: ["date", "type", "invoice_number", "method", "reference", "portion", "amount_zar", "vat_zar"],
};

export const incomeByMonthCsv = (rows: IncomeMonth[], vatRegistered: boolean): CsvRow[] =>
  rows.map((r) => ({ month: r.month.slice(0, 7), invoices: r.invoices, invoiced_zar: zar(r.invoicedCents), vat_zar: vatRegistered ? zar(r.vatCents) : null, vat_credited_zar: vatRegistered ? zar(r.vatCreditedCents) : null, received_zar: zar(r.receivedCents), credit_notes_zar: zar(r.creditCents) }));
export const incomeByMethodCsv = (rows: MethodRow[]): CsvRow[] => rows.map((r) => ({ method: r.method, payments: r.payments, received_zar: zar(r.receivedCents) }));
export const incomeBySessionTypeCsv = (rows: SessionTypeRow[]): CsvRow[] => rows.map((r) => ({ session_type: r.sessionType, invoices: r.invoices, invoiced_zar: zar(r.invoicedCents) }));
export const debtorsCsv = (rows: DebtorRow[], asOf: string): CsvRow[] =>
  rows.map((r) => ({
    as_of: asOf, invoice_number: r.invoiceNumber, due_date: r.dueDate, days_overdue: r.daysOverdue, age_bucket: AGEING_LABEL[r.bucket as AgeingBucket] ?? r.bucket, payer: r.payerType,
    outstanding_zar: zar(r.outstandingCents), scheme_zar: zar(r.schemeCents), patient_zar: zar(r.patientCents),
  }));
export const appointmentsCsv = (rows: AppointmentRow[]): CsvRow[] =>
  rows.map((r) => ({
    session_type: r.sessionType, booked: r.booked, attended: r.attended, no_show: r.noShow, cancelled: r.cancelled, late_cancelled: r.lateCancelled, booked_minutes: r.bookedMinutes,
    available_minutes: r.availableMinutes, utilisation_pct: percentNumber(r.utilisation), no_show_rate_pct: percentNumber(r.noShowRate), cancellation_rate_pct: percentNumber(r.cancellationRate),
  }));
export function activityCsv(a: Activity): CsvRow[] {
  const out: CsvRow[] = [];
  for (const m of a.newPatients) out.push({ section: "New patients", item: m.month, value: m.n });
  for (const r of a.referrals) out.push({ section: "Referral source", item: r.label, value: r.n });
  out.push({ section: "Active caseload (attended in the last 90 days)", item: "Patients", value: a.caseload });
  out.push({ section: "Tasks", item: "Created", value: a.tasksCreated }, { section: "Tasks", item: "Completed", value: a.tasksCompleted });
  out.push({ section: "Tasks", item: "Completion rate (%)", value: percentNumber(a.completionRate) });
  for (const c of a.claims) out.push({ section: "Claims created", item: claimStatusLabel(c.status), value: c.n });
  out.push({ section: "PayFast payments waiting to be matched (now)", item: "Open", value: a.payfastOpen });
  return out;
}
export function complianceCsv(c: Compliance): CsvRow[] {
  const out: CsvRow[] = c.activity.map((a) => ({ section: "System activity", item: ACTIVITY_LABEL[a.key] ?? a.key, status: null, count: a.n }));
  for (const k of c.consent) {
    const item = consentLabel(k.purpose);
    out.push({ section: "Consent now", item, status: "Granted", count: k.granted }, { section: "Consent now", item, status: "Withdrawn", count: k.withdrawn }, { section: "Consent now", item, status: "Not recorded", count: k.none });
  }
  out.push({ section: "Notifications", item: "Failed to send", status: null, count: c.failedNotifications }, { section: "PayFast", item: "Rejected after the signature check", status: null, count: c.payfastRejected });
  return out;
}
export const transactionsCsv = (rows: TransactionRow[]): CsvRow[] =>
  rows.map((r) => ({
    date: r.date, type: r.kind === "credit_note" ? "credit note" : "payment", invoice_number: r.invoiceNumber, method: r.method, reference: r.reference, portion: r.portion,
    amount_zar: zar(r.amountCents), vat_zar: zar(r.vatCents),
  }));

/** Read a report through the signed-in user's client and shape it for the CSV. `vatRegistered` is the practice setting; `asOf` the debtors "as at" date. */
export async function exportRows(sb: SupabaseClient, key: ExportKey, r: { from: string; to: string }, o: { vatRegistered: boolean; asOf: string }): Promise<CsvRow[]> {
  switch (key) {
    case "income_by_month": return incomeByMonthCsv(await fetchIncomeByMonth(sb, r), o.vatRegistered);
    case "income_by_method": return incomeByMethodCsv(await fetchIncomeByMethod(sb, r));
    case "income_by_session_type": return incomeBySessionTypeCsv(await fetchIncomeBySessionType(sb, r));
    case "debtors": return debtorsCsv(await fetchDebtors(sb, o.asOf), o.asOf);
    case "appointments": return appointmentsCsv(await fetchAppointments(sb, r));
    case "activity": return activityCsv(await fetchActivity(sb, r));
    case "compliance": return complianceCsv(await fetchCompliance(sb, r));
    case "transactions": return transactionsCsv(await fetchTransactions(sb, r));
  }
}
