import type { SupabaseClient } from "@supabase/supabase-js";
import type { Role } from "@/lib/auth/roles";
import { notesToComplete, type PendingNote } from "@/lib/notes/pending";
import { staleBefore } from "@/lib/claims/rules";
import { sortTasks } from "@/lib/tasks/list";
import { addDays, sastMidnight } from "@/lib/time";
import { dayBoundsUtc, minutesBetween, monthStart, must, section, upcomingBoundsUtc, type Section } from "./shape";

/**
 * The dashboard's data. Every query goes through the signed-in user's own (RLS) client, uses counts or SQL aggregates for numbers
 * (head counts, billing_open_by_due_date, dashboard_payments_by_method) and a small bounded list for rows. Each loader throws on a failed
 * query; `section()` turns that into { ok: false } so one failing query shows a quiet note for its own tile and nothing else.
 */
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const fullName = (p: { first_name: string; last_name: string } | null) => (p ? `${p.first_name} ${p.last_name}` : "Unknown patient");

type ApptRow = {
  id: string; starts_at: string; ends_at: string; status: string; patient_id: string;
  patients: { first_name: string; last_name: string } | { first_name: string; last_name: string }[] | null;
  session_types: { name: string; format: string } | { name: string; format: string }[] | null;
};
export type DashAppt = { id: string; starts_at: string; minutes: number; status: string; patientName: string; patientId: string; typeName: string; format: string };
const APPT_COLS = "id, starts_at, ends_at, status, patient_id, patients(first_name, last_name), session_types(name, format)";
const apptOf = (r: ApptRow): DashAppt => ({
  id: r.id, starts_at: r.starts_at, minutes: minutesBetween(r.starts_at, r.ends_at), status: r.status, patientId: r.patient_id,
  patientName: fullName(one(r.patients)), typeName: one(r.session_types)?.name ?? "Session", format: one(r.session_types)?.format ?? "in_person",
});

/** Today's sessions (SAST day), cancelled ones left out, in time order. */
export const loadToday = (sb: SupabaseClient, today: string) => section("today", async () => {
  const { from, to } = dayBoundsUtc(today);
  const { data } = must(await sb.from("appointments").select(APPT_COLS).gte("starts_at", from).lt("starts_at", to).neq("status", "cancelled").order("starts_at").limit(50));
  return (data as unknown as ApptRow[]).map(apptOf);
});

/** Tentative booking requests that have not started yet: the total and the first few by date. */
export const loadRequests = (sb: SupabaseClient, now: Date) => section("requests", async () => {
  const { data, count } = must(await sb.from("appointments").select(APPT_COLS, { count: "exact" }).eq("status", "tentative").gte("starts_at", now.toISOString()).order("starts_at").limit(8));
  return { total: count ?? data.length, items: (data as unknown as ApptRow[]).map(apptOf) };
});

/** Confirmed and tentative sessions over the 7 days after today (at most 20). */
export const loadUpcoming = (sb: SupabaseClient, today: string) => section("upcoming", async () => {
  const { from, to } = upcomingBoundsUtc(today);
  const { data } = must(await sb.from("appointments").select(APPT_COLS).gte("starts_at", from).lt("starts_at", to).in("status", ["confirmed", "tentative"]).order("starts_at").limit(20));
  return (data as unknown as ApptRow[]).map(apptOf);
});

export type Enquiry = { id: string; name: string; created_at: string };
/** Prospect patients created in the last 14 days. */
export const loadEnquiries = (sb: SupabaseClient, now: Date) => section("enquiries", async () => {
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const { data, count } = must(await sb.from("patients").select("id, first_name, last_name, created_at", { count: "exact" }).eq("status", "prospect").gte("created_at", since).order("created_at", { ascending: false }).limit(8));
  const rows = data as unknown as { id: string; first_name: string; last_name: string; created_at: string }[];
  return { total: count ?? rows.length, items: rows.map((r): Enquiry => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, created_at: r.created_at })) };
});

/** Forms submitted in the last 7 days: how many, and the patient of the newest one (the tile links to that patient's forms tab). */
export const loadSubmittedForms = (sb: SupabaseClient, now: Date) => section("forms", async () => {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const { data, count } = must(await sb.from("form_submissions").select("patient_id", { count: "exact" }).eq("status", "submitted").gte("submitted_at", since).order("submitted_at", { ascending: false }).limit(1));
  return { total: count ?? data.length, newestPatientId: (data as unknown as { patient_id: string }[])[0]?.patient_id ?? null };
});

type TaskRow = { id: string; title: string; due_at: string | null; priority: string; status: string; source: string | null; patient_id: string | null; appointment_id: string | null; meta: unknown; created_at: string };
export type DashTask = TaskRow;
/**
 * Open tasks: the count due today or earlier, the count of unreconciled PayFast payments, and the next 8 (earliest due day first, undated last, then
 * priority). The list is chosen from the first 40 by due date (ponytail: a practice with more than 40 open tasks sees the 8 most urgent of the 40
 * earliest-due; the Tasks page shows everything).
 */
export const loadTasks = (sb: SupabaseClient, today: string) => section("tasks", async () => {
  const tomorrow = sastMidnight(addDays(today, 1));
  const [list, dueN, pfN] = await Promise.all([
    sb.from("tasks").select("id, title, due_at, priority, status, source, patient_id, appointment_id, meta, created_at").eq("status", "open")
      .order("due_at", { ascending: true, nullsFirst: false }).order("created_at").limit(40),
    sb.from("tasks").select("id", { count: "exact", head: true }).eq("status", "open").lt("due_at", tomorrow),
    sb.from("tasks").select("id", { count: "exact", head: true }).eq("status", "open").like("source", "payfast_unreconciled:%"),
  ]);
  return {
    next: sortTasks(must(list).data as unknown as TaskRow[]).slice(0, 8),
    dueOrOverdue: must(dueN).count ?? 0,
    unreconciled: must(pfN).count ?? 0,
  };
});

export type InvoiceTotals = { openN: number; openCents: number; overdueN: number; overdueCents: number };
/** Open invoices from billing_open_by_due_date (one row per due date, summed in SQL); overdue = due before today (SAST). */
export const loadInvoices = (sb: SupabaseClient, today: string) => section("invoices", async () => {
  const { data } = must(await sb.rpc("billing_open_by_due_date"));
  const t: InvoiceTotals = { openN: 0, openCents: 0, overdueN: 0, overdueCents: 0 };
  for (const r of data as unknown as { due_date: string; n: number | string; outstanding_cents: number | string }[]) {
    const n = Number(r.n), c = Number(r.outstanding_cents);
    t.openN += n; t.openCents += c;
    if (r.due_date < today) { t.overdueN += n; t.overdueCents += c; }
  }
  return t;
});

/** Claims that need a look: rejected, and submitted more than 30 days ago with no answer. */
export const loadClaims = (sb: SupabaseClient, today: string) => section("claims", async () => {
  const [rej, stale] = await Promise.all([
    sb.from("claims").select("id", { count: "exact", head: true }).eq("status", "rejected"),
    sb.from("claims").select("id", { count: "exact", head: true }).eq("status", "submitted").lt("submitted_at", staleBefore(today)),
  ]);
  return { rejected: must(rej).count ?? 0, stale: must(stale).count ?? 0 };
});

export type MethodTotal = { method: string; n: number; totalCents: number };
/** Payments received this month so far, per method, summed in SQL (dashboard_payments_by_method, 0024). */
export const loadPayments = (sb: SupabaseClient, today: string) => section("payments", async () => {
  const { data } = must(await sb.rpc("dashboard_payments_by_method", { p_from: monthStart(today), p_to: today }));
  return (data as unknown as { method: string; n: number | string; total_cents: number | string }[]).map((r): MethodTotal => ({ method: r.method, n: Number(r.n), totalCents: Number(r.total_cents) }));
});

/** Notes to complete: the psychologist only. Any other role gets { ok: true, data: null } and nothing about notes is queried. */
export const loadNotes = (sb: SupabaseClient, role: Role): Promise<Section<{ count: number; first: PendingNote | null } | null>> => section("notes", async () => {
  if (role !== "psychologist") return null;
  const r = await notesToComplete(sb, role);
  if (!r) throw new Error("notes_failed");
  return { count: r.count, first: r.items[r.items.length - 1] ?? null }; // items are newest first; the oldest unfinished note is the one to do first
});

export type DashboardData = {
  today: Section<DashAppt[]>; requests: Section<{ total: number; items: DashAppt[] }>; upcoming: Section<DashAppt[]>;
  enquiries: Section<{ total: number; items: Enquiry[] }>; forms: Section<{ total: number; newestPatientId: string | null }>;
  tasks: Section<{ next: DashTask[]; dueOrOverdue: number; unreconciled: number }>; invoices: Section<InvoiceTotals>;
  claims: Section<{ rejected: number; stale: number }>; payments: Section<MethodTotal[]>; notes: Section<{ count: number; first: PendingNote | null } | null>;
};

/** Everything at once (parallel). `role` is psychologist or admin: the admin gets the same operational data and no notes. */
export async function loadDashboard(sb: SupabaseClient, role: Role, now: Date, today: string): Promise<DashboardData> {
  const [todayR, requests, upcoming, enquiries, forms, tasks, invoices, claims, payments, notes] = await Promise.all([
    loadToday(sb, today), loadRequests(sb, now), loadUpcoming(sb, today), loadEnquiries(sb, now), loadSubmittedForms(sb, now),
    loadTasks(sb, today), loadInvoices(sb, today), loadClaims(sb, today), loadPayments(sb, today), loadNotes(sb, role),
  ]);
  return { today: todayR, requests, upcoming, enquiries, forms, tasks, invoices, claims, payments, notes };
}
