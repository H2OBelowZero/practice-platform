import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { FEE_TASK_SELECT, feeTaskItems, type FeeTaskRow } from "@/lib/billing/fee-tasks";
import { isOverdue, PAYER_FILTERS, PAYER_LABEL, parseOverdueFilter, parsePayerFilter, parseStatusFilter, STATUS_FILTERS } from "@/lib/billing/list";
import { billingNotice } from "@/lib/billing/notices";
import { formatZar } from "@/lib/money";
import { hrefWith, pageCount, pageRange, parsePage } from "@/lib/patients/list";
import { cleanSearch } from "@/lib/patients/search";
import { AGEING_BUCKETS, AGEING_LABEL, ageingSummary } from "@/lib/reports/ageing";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDayShort } from "@/lib/time";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Pager } from "@/components/ui/pager";
import { StatusChip } from "@/components/ui/status-chip";
import { FeeTasksList } from "./fee-tasks";

export const metadata = { title: "Billing" };

type Row = {
  id: string; number: string; patient_id: string; status: string; payer_type: string; issue_date: string; due_date: string;
  total_cents: number; outstanding_cents: number;
};

const day = (d: string) => sastDayShort(d, true);

/**
 * Invoices for the practice. Psychologist, admin and bookkeeper may open it; the bookkeeper sees invoice numbers, dates, amounts, status and payer
 * type only (no patient names, no links to patients: the page does not even read the patients table for that role).
 * The totals strip and the ageing table are summed in the database (billing_totals, billing_open_by_due_date, 0015) for exactly the
 * filtered set, so they are correct however many invoices there are. Ageing always covers every open invoice, whatever the filters.
 */
export default async function BillingPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; payer?: string; overdue?: string; page?: string; notice?: string }> }) {
  const me = await requireRole(["psychologist", "admin", "bookkeeper"]);
  const sp = await searchParams;
  const q = cleanSearch(sp.q ?? "");
  const status = parseStatusFilter(sp.status);
  const payer = parsePayerFilter(sp.payer);
  const overdue = parseOverdueFilter(sp.overdue);
  const page = parsePage(sp.page);
  const notice = billingNotice(sp.notice);
  const today = sastDate(new Date());
  const { from, to } = pageRange(page);
  const here = (p: number) => hrefWith("/app/billing", { q, status, payer, overdue: overdue ? "1" : undefined, page: p > 1 ? p : undefined });
  const names = me.role !== "bookkeeper";

  const sb = await supabaseServer();
  let query = sb.from("invoice_balances").select("id, number, patient_id, status, payer_type, issue_date, due_date, total_cents, outstanding_cents", { count: "exact" });
  if (status) query = query.eq("status", status);
  if (payer) query = query.eq("payer_type", payer);
  if (overdue) query = query.lt("due_date", today).in("status", ["issued", "part_paid"]);
  if (q) query = query.ilike("number", `%${q}%`);
  const [res, totalsRes, ageingRes] = await Promise.all([
    query.order("created_at", { ascending: false }).order("id").range(from, to),
    sb.rpc("billing_totals", { p_status: status || null, p_payer: payer || null, p_overdue: overdue, p_q: q || null, p_today: today }),
    sb.rpc("billing_open_by_due_date"),
  ]);
  if (res.error?.code === "PGRST103" && page > 1) redirect(here(1)); // a page past the end (hand-typed URL)

  const rows = (res.data ?? []) as Row[];
  const total = res.count ?? rows.length;
  const t = (totalsRes.data as { n: number; invoiced_cents: number; credited_cents: number; received_cents: number; outstanding_cents: number }[] | null)?.[0];
  const ageing = ageingRes.error ? null : ageingSummary(
    ((ageingRes.data ?? []) as { due_date: string; n: number; outstanding_cents: number }[]).map((r) => ({ dueDate: r.due_date, n: Number(r.n), outstandingCents: Number(r.outstanding_cents) })), today);

  // open late-cancellation fee tasks (psychologist and admin only: the bookkeeper cannot read tasks)
  const feeRows = names ? ((await sb.from("tasks").select(FEE_TASK_SELECT).eq("source", "late_cancel_fee").eq("status", "open").order("created_at").limit(20)).data ?? []) as unknown as FeeTaskRow[] : [];
  const nameOf = new Map<string, string>();
  const nameIds = [...new Set([...rows.map((r) => r.patient_id), ...feeRows.map((f) => f.patient_id).filter((x): x is string => !!x)])];
  if (names && nameIds.length) {
    const { data: ps } = await sb.from("patients").select("id, first_name, last_name").in("id", nameIds);
    for (const p of ps ?? []) nameOf.set(p.id as string, `${p.first_name} ${p.last_name}`);
  }
  const fees = feeTaskItems(feeRows, nameOf);
  const filtered = q !== "" || status !== "" || payer !== "" || overdue;

  return (
    <>
      <PageHeader title="Billing" description={names ? "Invoices, payments and what is still owed. To invoice a session, use the Create invoice button on the attended appointment, or the patient's Billing tab." : "Invoices, payments and what is still owed."} />
      {notice && <Notice tone="success">{notice}</Notice>}
      <FeeTasksList items={fees} headingId="fees-h" />

      <section aria-labelledby="totals-h" className="mb-8">
        <h2 id="totals-h" className="sr-only">Totals for the invoices listed</h2>
        {t ? (
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[["Invoiced", t.invoiced_cents], ["Credit notes", t.credited_cents], ["Received", t.received_cents], ["Outstanding", t.outstanding_cents]].map(([label, cents]) => (
              <div key={label as string} className="rounded-card border border-line bg-surface p-4 shadow-card">
                <dt className="text-sm text-ink-muted">{label}</dt>
                <dd className="mt-1 text-xl font-semibold">{formatZar(Number(cents))}</dd>
              </div>
            ))}
          </dl>
        ) : <Notice tone="error">We could not work out the totals. Please refresh the page.</Notice>}
        <p className="mt-2 text-sm text-ink-muted">
          {filtered ? `For the ${t ? Number(t.n) : "listed"} invoices matching the filters below` : `For all ${t ? Number(t.n) : ""} invoices`}. Invoiced, credit notes and received count issued, part paid and paid invoices; drafts and void invoices are not counted.
        </p>
      </section>

      <form method="get" action="/app/billing" role="search" aria-label="Filter invoices" className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-44 flex-1 [&>div]:mb-0"><Input id="q" label="Invoice number" type="search" defaultValue={q} maxLength={40} placeholder="INV-00012" /></div>
        <div className="min-w-40 flex-1 [&>div]:mb-0">
          <Select id="status" label="Status" defaultValue={status}>{STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
        </div>
        <div className="min-w-40 flex-1 [&>div]:mb-0">
          <Select id="payer" label="Who pays" defaultValue={payer}>{PAYER_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
        </div>
        <div className="flex min-h-11 items-center gap-2">
          <input id="overdue" name="overdue" type="checkbox" value="1" defaultChecked={overdue} className="h-6 w-6 accent-sage-700" />
          <label htmlFor="overdue" className="font-medium">Overdue only</label>
        </div>
        <Button type="submit" variant="secondary">Apply</Button>
        {filtered && <LinkButton variant="quiet" href="/app/billing">Clear</LinkButton>}
      </form>

      {res.error && <Notice tone="error">We could not load the invoices. Please refresh the page.</Notice>}
      {!res.error && rows.length === 0 && <Notice tone="info">{filtered ? "No invoices match. Try different filters." : "There are no invoices yet."}</Notice>}

      {rows.length > 0 && (
        <>
          <div className="hidden overflow-x-auto rounded-card border border-line bg-surface shadow-card md:block">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Invoices, newest first</caption>
              <thead className="bg-sunk text-sm text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Invoice</th>
                  {names && <th scope="col" className="px-4 py-3 font-medium">Patient</th>}
                  <th scope="col" className="px-4 py-3 font-medium">Issued</th>
                  <th scope="col" className="px-4 py-3 font-medium">Due</th>
                  <th scope="col" className="px-4 py-3 font-medium">Who pays</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Total</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Outstanding</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <th scope="row" className="px-4 py-3 font-medium whitespace-nowrap"><Link href={`/app/billing/${r.id}`}>{r.number}</Link></th>
                    {names && <td className="px-4 py-3">{nameOf.has(r.patient_id) ? <Link href={`/app/patients/${r.patient_id}`}>{nameOf.get(r.patient_id)}</Link> : <span className="text-ink-muted">Unknown patient</span>}</td>}
                    <td className="px-4 py-3 whitespace-nowrap">{r.status === "draft" ? <span className="text-ink-muted">Not issued</span> : day(r.issue_date)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{r.status === "draft" || r.status === "void" ? <span className="text-ink-muted">{day(r.due_date)}</span> : day(r.due_date)}</td>
                    <td className="px-4 py-3">{PAYER_LABEL[r.payer_type] ?? r.payer_type}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(r.total_cents)}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(r.outstanding_cents)}</td>
                    <td className="px-4 py-3"><div className="flex flex-wrap gap-1.5"><StatusChip status={r.status} />{isOverdue({ status: r.status, due_date: r.due_date }, today) && <StatusChip status="overdue" />}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul aria-label="Invoices" className="m-0 grid list-none gap-3 p-0 md:hidden">
            {rows.map((r) => (
              <li key={r.id} className="rounded-card border border-line bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <Link href={`/app/billing/${r.id}`} className="font-medium">{r.number}</Link>
                  <div className="flex flex-wrap gap-1.5"><StatusChip status={r.status} />{isOverdue({ status: r.status, due_date: r.due_date }, today) && <StatusChip status="overdue" />}</div>
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  {names && <><dt className="text-ink-muted">Patient</dt><dd>{nameOf.has(r.patient_id) ? <Link href={`/app/patients/${r.patient_id}`}>{nameOf.get(r.patient_id)}</Link> : "Unknown patient"}</dd></>}
                  <dt className="text-ink-muted">Issued</dt><dd>{r.status === "draft" ? "Not issued" : day(r.issue_date)}</dd>
                  <dt className="text-ink-muted">Due</dt><dd>{day(r.due_date)}</dd>
                  <dt className="text-ink-muted">Who pays</dt><dd>{PAYER_LABEL[r.payer_type] ?? r.payer_type}</dd>
                  <dt className="text-ink-muted">Total</dt><dd>{formatZar(r.total_cents)}</dd>
                  <dt className="text-ink-muted">Outstanding</dt><dd>{formatZar(r.outstanding_cents)}</dd>
                </dl>
              </li>
            ))}
          </ul>
          <Pager page={page} pages={pageCount(total)} total={total} from={from} to={to} hrefFor={here} label="Invoice list pages" />
        </>
      )}

      <section aria-labelledby="ageing-h" className="mt-10">
        <h2 id="ageing-h" className="mb-2">Ageing of open invoices</h2>
        <p className="mb-4 max-w-2xl text-ink-muted">What is still owed on issued and part paid invoices, by how long it is past its due date. This covers every open invoice, whatever the filters above.</p>
        {!ageing ? <Notice tone="error">We could not load the ageing summary. Please refresh the page.</Notice> : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Outstanding amounts by days overdue</caption>
              <thead className="bg-sunk text-sm text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Age</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Invoices</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {AGEING_BUCKETS.map((b) => (
                  <tr key={b} className="border-t border-line">
                    <th scope="row" className="px-4 py-3 font-medium">{AGEING_LABEL[b]}</th>
                    <td className="px-4 py-3 text-right">{ageing[b].n}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(ageing[b].outstandingCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
