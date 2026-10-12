import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "@/lib/auth/roles";
import type { Section } from "@/lib/dashboard/shape";
import { debtorsAsOf, type DateRange } from "./periods";
import {
  fetchActivity, fetchAgeing, fetchAppointments, fetchCompliance, fetchDebtors, fetchIncomeByMethod, fetchIncomeByMonth, fetchIncomeBySessionType,
  type Activity, type AgeingRow, type AppointmentRow, type Compliance, type DebtorRow, type IncomeMonth, type MethodRow, type SessionTypeRow,
} from "./queries";

/** One section's data or "could not load": a failed query never takes the page down, and only a short code is logged (the message may echo a value). */
export async function reportSection<T>(name: string, fn: () => Promise<T>): Promise<Section<T>> {
  try { return { ok: true, data: await fn() }; } catch (e) {
    console.error(`reports ${name} failed:`, e instanceof Error ? e.message.slice(0, 60) : "unknown");
    return { ok: false };
  }
}

/** The debtors table shows at most this many invoices (oldest due first); the CSV has all of them. */
export const DEBTOR_ROWS_SHOWN = 200;

export type Debtors = { rows: DebtorRow[]; total: number; names: Record<string, string> | null };
export type Financial = {
  vatRegistered: Section<boolean>; income: Section<IncomeMonth[]>; methods: Section<MethodRow[]>; sessionTypes: Section<SessionTypeRow[]>;
  ageing: Section<AgeingRow[]>; debtors: Section<Debtors>; asOf: string;
};

/**
 * Patient names for the debtors table, read through the signed-in user's own client (RLS decides: psychologist and admin can read patients, the bookkeeper cannot, and is not
 * asked). Ids only come from the debtors rows, at most DEBTOR_ROWS_SHOWN of them. A failed lookup leaves names null and the table says the names are unavailable.
 */
async function patientNames(sb: SupabaseClient, ids: string[]): Promise<Record<string, string> | null> {
  if (ids.length === 0) return {};
  const { data, error } = await sb.from("patients").select("id, first_name, last_name").in("id", ids);
  if (error) { console.error("reports patient names failed:", error.code ?? ""); return null; }
  return Object.fromEntries((data ?? []).map((p: { id: string; first_name: string; last_name: string }) => [p.id, `${p.first_name} ${p.last_name}`.trim()]));
}

export async function loadFinancial(sb: SupabaseClient, role: Role, r: DateRange, today: string): Promise<Financial> {
  const asOf = debtorsAsOf(r.to, today);
  const [vatRegistered, income, methods, sessionTypes, ageing, debtors] = await Promise.all([
    reportSection("vat", async () => {
      const { data, error } = await sb.from("practices").select("vat_registered").limit(1).maybeSingle();
      if (error) throw new Error(`query_failed:${error.code ?? ""}`);
      return (data as { vat_registered?: boolean } | null)?.vat_registered === true;
    }),
    reportSection("income_by_month", () => fetchIncomeByMonth(sb, r)),
    reportSection("income_by_method", () => fetchIncomeByMethod(sb, r)),
    reportSection("income_by_session_type", () => fetchIncomeBySessionType(sb, r)),
    reportSection("debtors_ageing", () => fetchAgeing(sb, asOf)),
    reportSection("debtors_detail", async (): Promise<Debtors> => {
      const all = await fetchDebtors(sb, asOf);
      const rows = all.slice(0, DEBTOR_ROWS_SHOWN);
      // the bookkeeper's rows carry no patient id and the bookkeeper is not asked for names
      const ids = role === "bookkeeper" ? [] : [...new Set(rows.flatMap((x) => (x.patientId ? [x.patientId] : [])))];
      return { rows, total: all.length, names: role === "bookkeeper" ? null : await patientNames(sb, ids) };
    }),
  ]);
  return { vatRegistered, income, methods, sessionTypes, ageing, debtors, asOf };
}

export const loadAppointmentsReport = (sb: SupabaseClient, r: DateRange): Promise<Section<AppointmentRow[]>> => reportSection("appointments", () => fetchAppointments(sb, r));
export const loadActivityReport = (sb: SupabaseClient, r: DateRange): Promise<Section<Activity>> => reportSection("activity", () => fetchActivity(sb, r));
export const loadComplianceReport = (sb: SupabaseClient, r: DateRange): Promise<Section<Compliance>> => reportSection("compliance", () => fetchCompliance(sb, r));
