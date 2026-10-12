import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { portionSummary } from "@/lib/billing/portions";
import { CLAIM_STATUSES, daysSince, staleBefore, STALE_DAYS } from "@/lib/claims/rules";
import { CLAIM_STATUS_FILTERS, MANUAL_SUBMISSION_NOTE, parseClaimStatusFilter } from "@/lib/claims/view";
import { formatZar } from "@/lib/money";
import { hrefWith, pageCount, pageRange, parsePage } from "@/lib/patients/list";
import { cleanSearch } from "@/lib/patients/search";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Pager } from "@/components/ui/pager";
import { StatusChip } from "@/components/ui/status-chip";

export const metadata = { title: "Claims" };

type Inv = { number: string; patient_id: string; status: string; total_cents: number; scheme_portion_cents: number; patient_portion_cents: number };
type Row = { id: string; invoice_id: string; status: string; claimed_cents: number; submitted_at: string | null; invoices: Inv | Inv[] | null; medical_aid_members: { scheme: string } | { scheme: string }[] | null };
const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

/**
 * Medical aid claims for the practice. Psychologist and admin only (the bookkeeper sees claim status and amounts on the invoice pages, and everyone else gets a 404).
 * The list shows who, which scheme, which invoice, the status and the money: NO diagnosis codes anywhere on this page (the query does not even select them).
 * "Scheme owes" and "Patient owes" are the open parts of the invoice's two portions (portionSummary), never added together.
 */
export default async function ClaimsPage({ searchParams }: { searchParams: Promise<{ status?: string; scheme?: string; stale?: string; page?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const sp = await searchParams;
  const status = parseClaimStatusFilter(sp.status);
  const scheme = cleanSearch(sp.scheme ?? "");
  const stale = sp.stale === "1";
  const page = parsePage(sp.page);
  const today = sastDate(new Date());
  const cutoff = staleBefore(today);
  const { from, to } = pageRange(page);
  const here = (p: number) => hrefWith("/app/claims", { status, scheme, stale: stale ? "1" : undefined, page: p > 1 ? p : undefined });

  const sb = await supabaseServer();
  let query = sb.from("claims").select(
    `id, invoice_id, status, claimed_cents, submitted_at, invoices(number, patient_id, status, total_cents, scheme_portion_cents, patient_portion_cents), medical_aid_members${scheme ? "!inner" : ""}(scheme)`,
    { count: "exact" });
  if (status) query = query.eq("status", status);
  if (stale) query = query.eq("status", "submitted").lt("submitted_at", cutoff);
  if (scheme) query = query.ilike("medical_aid_members.scheme", `%${scheme}%`);
  const counts = CLAIM_STATUSES.map((s) => sb.from("claims").select("id", { count: "exact", head: true }).eq("status", s));
  const staleCount = sb.from("claims").select("id", { count: "exact", head: true }).eq("status", "submitted").lt("submitted_at", cutoff);
  const [res, staleRes, ...countRes] = await Promise.all([query.order("created_at", { ascending: false }).order("id").range(from, to), staleCount, ...counts]);
  if (res.error?.code === "PGRST103" && page > 1) redirect(here(1)); // a page past the end (hand-typed URL)

  const rows = (res.data ?? []) as unknown as Row[];
  const total = res.count ?? rows.length;
  const byStatus = Object.fromEntries(CLAIM_STATUSES.map((s, i) => [s, countRes[i].error ? null : (countRes[i].count ?? 0)]));

  // names, and the open amounts of each listed invoice's two portions
  const invoiceIds = [...new Set(rows.map((r) => r.invoice_id))];
  const patientIds = [...new Set(rows.map((r) => one(r.invoices)?.patient_id).filter((x): x is string => !!x))];
  const [pats, pays, credits] = rows.length ? await Promise.all([
    sb.from("patients").select("id, first_name, last_name").in("id", patientIds),
    sb.from("payments").select("invoice_id, method, amount_cents").in("invoice_id", invoiceIds).eq("status", "succeeded"),
    sb.from("credit_notes").select("invoice_id, portion, amount_cents").in("invoice_id", invoiceIds),
  ]) : [null, null, null];
  const nameOf = new Map((pats?.data ?? []).map((p) => [p.id as string, `${p.first_name} ${p.last_name}`]));
  const open = (r: Row) => {
    const inv = one(r.invoices);
    if (!inv || pays?.error || credits?.error) return null;
    return portionSummary({
      status: inv.status, totalCents: inv.total_cents, schemeCents: inv.scheme_portion_cents, patientCents: inv.patient_portion_cents,
      credits: (credits?.data ?? []).filter((c) => c.invoice_id === r.invoice_id).map((c) => ({ portion: c.portion as string, amountCents: c.amount_cents as number })),
      payments: (pays?.data ?? []).filter((p) => p.invoice_id === r.invoice_id).map((p) => ({ method: p.method as string, amountCents: p.amount_cents as number })),
    }).perPortion;
  };
  const waiting = (r: Row) => (["submitted", "accepted", "part_paid"].includes(r.status) ? daysSince(r.submitted_at, today) : null);
  const waitText = (r: Row) => { const d = waiting(r); return d === null ? "-" : d === 0 ? "Today" : d === 1 ? "1 day" : `${d} days`; };
  const filtered = status !== "" || scheme !== "" || stale;
  const rejectedN = byStatus.rejected;
  const staleN = staleRes.error ? null : (staleRes.count ?? 0);

  const money = (r: Row) => {
    const p = open(r);
    return { scheme: p ? formatZar(p.schemeCents) : "-", patient: p ? formatZar(p.patientCents) : "-" };
  };

  return (
    <>
      <PageHeader title="Claims" description="Medical aid claims and what the scheme and the patient still owe. Open a claim from an issued medical aid invoice." />
      <Notice tone="info" title="Manual submission"><p>{MANUAL_SUBMISSION_NOTE}</p></Notice>

      <section aria-labelledby="attn-h" className="mb-8">
        <h2 id="attn-h" className="mb-3">Claims needing attention</h2>
        <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2">
          <li className="rounded-card border border-line bg-surface p-4 shadow-card">
            <p className="text-xl font-semibold">{rejectedN === null ? "?" : rejectedN}</p>
            <p><Link href="/app/claims?status=rejected">Rejected claims</Link><span className="text-ink-muted"> to correct or resubmit</span></p>
          </li>
          <li className="rounded-card border border-line bg-surface p-4 shadow-card">
            <p className="text-xl font-semibold">{staleN === null ? "?" : staleN}</p>
            <p><Link href="/app/claims?stale=1">Submitted over {STALE_DAYS} days ago</Link><span className="text-ink-muted"> and not yet answered</span></p>
          </li>
        </ul>
      </section>

      <section aria-labelledby="board-h" className="mb-8">
        <h2 id="board-h" className="mb-3">By status</h2>
        <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-3 lg:grid-cols-6">
          {CLAIM_STATUSES.map((s) => (
            <li key={s} className="rounded-card border border-line bg-surface p-4 shadow-card">
              <StatusChip status={s} />
              <p className="mt-2 text-xl font-semibold">{byStatus[s] === null ? "?" : byStatus[s]}</p>
              <Link href={`/app/claims?status=${s}`} aria-label={`Show ${CLAIM_STATUS_FILTERS.find((f) => f.value === s)?.label.toLowerCase()} claims`}>Show</Link>
            </li>
          ))}
        </ul>
      </section>

      <form method="get" action="/app/claims" role="search" aria-label="Filter claims" className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-40 flex-1 [&>div]:mb-0">
          <Select id="status" label="Status" defaultValue={status}>{CLAIM_STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
        </div>
        <div className="min-w-44 flex-1 [&>div]:mb-0"><Input id="scheme" label="Medical aid scheme" type="search" defaultValue={scheme} maxLength={60} placeholder="Discovery" /></div>
        <div className="flex min-h-11 items-center gap-2">
          <input id="stale" name="stale" type="checkbox" value="1" defaultChecked={stale} className="h-6 w-6 accent-sage-700" />
          <label htmlFor="stale" className="font-medium">Waiting over {STALE_DAYS} days</label>
        </div>
        <Button type="submit" variant="secondary">Apply</Button>
        {filtered && <LinkButton variant="quiet" href="/app/claims">Clear</LinkButton>}
      </form>

      {res.error && <Notice tone="error">We could not load the claims. Please refresh the page.</Notice>}
      {!res.error && rows.length === 0 && <Notice tone="info">{filtered ? "No claims match. Try different filters." : "There are no claims yet."}</Notice>}

      {rows.length > 0 && (
        <>
          <div className="hidden overflow-x-auto rounded-card border border-line bg-surface shadow-card md:block">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Claims, newest first</caption>
              <thead className="bg-sunk text-sm text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Patient</th>
                  <th scope="col" className="px-4 py-3 font-medium">Scheme</th>
                  <th scope="col" className="px-4 py-3 font-medium">Invoice</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Claimed</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Scheme owes</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Patient owes</th>
                  <th scope="col" className="px-4 py-3 font-medium">Since submitted</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const inv = one(r.invoices), m = money(r);
                  return (
                    <tr key={r.id} className="border-t border-line align-top">
                      <th scope="row" className="px-4 py-3 font-medium">{inv && nameOf.has(inv.patient_id) ? <Link href={`/app/claims/${r.id}`}>{nameOf.get(inv.patient_id)}</Link> : <Link href={`/app/claims/${r.id}`}>Unknown patient</Link>}</th>
                      <td className="px-4 py-3">{one(r.medical_aid_members)?.scheme ?? "-"}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{inv ? <Link href={`/app/billing/${r.invoice_id}`}>{inv.number}</Link> : "-"}</td>
                      <td className="px-4 py-3"><StatusChip status={r.status} /></td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(r.claimed_cents)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{m.scheme}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{m.patient}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{waitText(r)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <ul aria-label="Claims" className="m-0 grid list-none gap-3 p-0 md:hidden">
            {rows.map((r) => {
              const inv = one(r.invoices), m = money(r);
              return (
                <li key={r.id} className="rounded-card border border-line bg-surface p-4 shadow-card">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <Link href={`/app/claims/${r.id}`} className="font-medium">{inv && nameOf.get(inv.patient_id) ? nameOf.get(inv.patient_id) : "Unknown patient"}</Link>
                    <StatusChip status={r.status} />
                  </div>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-ink-muted">Scheme</dt><dd>{one(r.medical_aid_members)?.scheme ?? "-"}</dd>
                    <dt className="text-ink-muted">Invoice</dt><dd>{inv ? <Link href={`/app/billing/${r.invoice_id}`}>{inv.number}</Link> : "-"}</dd>
                    <dt className="text-ink-muted">Claimed</dt><dd>{formatZar(r.claimed_cents)}</dd>
                    <dt className="text-ink-muted">Scheme owes</dt><dd>{m.scheme}</dd>
                    <dt className="text-ink-muted">Patient owes</dt><dd>{m.patient}</dd>
                    <dt className="text-ink-muted">Since submitted</dt><dd>{waitText(r)}</dd>
                  </dl>
                </li>
              );
            })}
          </ul>
          <Pager page={page} pages={pageCount(total)} total={total} from={from} to={to} hrefFor={here} label="Claim list pages" />
        </>
      )}
    </>
  );
}
