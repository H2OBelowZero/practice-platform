import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { hrefWith, LIST_STATUS_FILTERS, pageCount, pageRange, parseListStatus, parsePage } from "@/lib/patients/list";
import { patientNotice } from "@/lib/patients/notices";
import { patientNo } from "@/lib/patients/age";
import { cleanSearch, patientNumberQuery, wordFilter } from "@/lib/patients/search";
import { supabaseServer } from "@/lib/supabase/server";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Pager } from "@/components/ui/pager";
import { StatusChip } from "@/components/ui/status-chip";

export const metadata = { title: "Patients" };

type Row = { id: string; patient_number: number; first_name: string; last_name: string; email: string | null; phone: string | null; status: string };

/** Staff patient list: search (name, email, phone, patient number), status filter, 25 per page. Listed through the staff user's own RLS. */
export default async function PatientsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string; notice?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const sp = await searchParams;
  const q = cleanSearch(sp.q ?? "");
  const status = parseListStatus(sp.status);
  const page = parsePage(sp.page);
  const notice = patientNotice(sp.notice);
  const { from, to } = pageRange(page);
  const here = (p: number) => hrefWith("/app/patients", { q, status, page: p > 1 ? p : undefined });

  const sb = await supabaseServer();
  let query = sb.from("patients").select("id, patient_number, first_name, last_name, email, phone, status", { count: "exact" });
  if (status === "") query = query.neq("status", "archived");
  else if (status !== "all") query = query.eq("status", status);
  // every word must match somewhere (name, email or phone); a whole-search number also matches the patient number
  const number = patientNumberQuery(q);
  if (number !== null) query = query.or(`patient_number.eq.${number},${wordFilter(q)}`);
  else for (const w of q.split(" ").filter(Boolean).slice(0, 5)) query = query.or(wordFilter(w));
  const res = await query.order("last_name").order("first_name").order("id").range(from, to);
  if (res.error?.code === "PGRST103" && page > 1) redirect(here(1)); // a page past the end (hand-typed URL)

  const rows = (res.data ?? []) as Row[];
  const total = res.count ?? rows.length;
  const filtered = q !== "" || status !== "";

  return (
    <>
      <PageHeader title="Patients" description="Everyone the practice has on file." actions={<LinkButton href="/app/patients/new">New patient</LinkButton>} />
      {notice && <Notice tone="success">{notice}</Notice>}

      <form method="get" action="/app/patients" role="search" aria-label="Find a patient" className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-[2] [&>div]:mb-0">
          <Input id="q" label="Search" type="search" defaultValue={q} maxLength={60} hint="Name, email, phone number or patient number." />
        </div>
        <div className="min-w-48 flex-1 [&>div]:mb-0">
          <Select id="status" label="Show" defaultValue={status}>
            {LIST_STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </Select>
        </div>
        <Button type="submit" variant="secondary">Apply</Button>
        {filtered && <LinkButton variant="quiet" href="/app/patients">Clear</LinkButton>}
      </form>

      {res.error && <Notice tone="error">We could not load the patients. Please refresh the page.</Notice>}
      {!res.error && rows.length === 0 && (
        <Notice tone="info">{filtered ? "No patients match. Try fewer words or a different filter." : "There are no patients yet. Add the first one with the New patient button."}</Notice>
      )}

      {rows.length > 0 && (
        <>
          {/* wide screens: a table; phones: a list of cards (the other one is display:none, so screen readers read only one) */}
          <div className="hidden overflow-x-auto rounded-card border border-line bg-surface shadow-card md:block">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Patients, sorted by last name</caption>
              <thead className="bg-sunk text-sm text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Patient</th>
                  <th scope="col" className="px-4 py-3 font-medium">Number</th>
                  <th scope="col" className="px-4 py-3 font-medium">Email</th>
                  <th scope="col" className="px-4 py-3 font-medium">Phone</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <th scope="row" className="px-4 py-3 font-medium"><Link href={`/app/patients/${p.id}`}>{p.first_name} {p.last_name}</Link></th>
                    <td className="px-4 py-3">{patientNo(p.patient_number)}</td>
                    <td className="break-all px-4 py-3">{p.email ?? <span className="text-ink-muted">Not given</span>}</td>
                    <td className="px-4 py-3">{p.phone ?? <span className="text-ink-muted">Not given</span>}</td>
                    <td className="px-4 py-3"><StatusChip status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul aria-label="Patients" className="m-0 grid list-none gap-3 p-0 md:hidden">
            {rows.map((p) => (
              <li key={p.id} className="rounded-card border border-line bg-surface p-4 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/app/patients/${p.id}`} className="font-medium">{p.first_name} {p.last_name}</Link>
                  <StatusChip status={p.status} />
                </div>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-muted">Number</dt><dd>{patientNo(p.patient_number)}</dd>
                  <dt className="text-ink-muted">Email</dt><dd className="break-all">{p.email ?? "Not given"}</dd>
                  <dt className="text-ink-muted">Phone</dt><dd>{p.phone ?? "Not given"}</dd>
                </dl>
              </li>
            ))}
          </ul>
          <Pager page={page} pages={pageCount(total)} total={total} from={from} to={to} hrefFor={here} label="Patient list pages" />
        </>
      )}
    </>
  );
}
