import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { auditDetailSummary, auditTime, shortEntityId } from "@/lib/audit-viewer/detail";
import { activeFilterNames, applyAuditFilters, AUDIT_ENTITIES, AUDIT_PREFIXES, AUDIT_ROLES, EXPORT_MAX_ROWS, filterParams, parseAuditFilters } from "@/lib/audit-viewer/filters";
import { ROLE_LABEL } from "@/lib/billing/list";
import { auditActionText } from "@/lib/patients/audit-view";
import { hrefWith, parsePage } from "@/lib/patients/list";
import { supabaseServer } from "@/lib/supabase/server";
import { AnchorButton, Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Pager } from "@/components/ui/pager";

export const metadata = { title: "Audit log" };

const PAGE = 50;
type Row = { id: number; role: string | null; action: string; entity: string | null; entity_id: string | null; detail: unknown; at: string };

/**
 * The audit log: who did what, newest first, 50 per page, with filters and a CSV export. Psychologist ONLY (the admin and everyone else get a 404;
 * the database also returns nothing to anyone else). Opening the viewer is itself audited (audit.view: the names of the filters in use, never their values)
 * BEFORE anything is read, and fails closed like patient.view: if the audit row cannot be written the page does not show. The detail column
 * shows only whitelisted keys (lib/audit-viewer/detail.ts), never free text.
 */
export default async function AuditPage({ searchParams }: { searchParams: Promise<{ prefix?: string; entity?: string; role?: string; from?: string; to?: string; page?: string }> }) {
  await requireRole(["psychologist"]);
  const sp = await searchParams;
  const f = parseAuditFilters(sp);
  const page = parsePage(sp.page);
  const from = (page - 1) * PAGE, to = from + PAGE - 1;
  const here = (p: number) => hrefWith("/app/audit", { ...filterParams(f), page: p > 1 ? p : undefined });
  const filtered = activeFilterNames(f).length > 0;

  await audit("audit.view", "audit_log", undefined, { filters: activeFilterNames(f), page });

  const sb = await supabaseServer();
  const res = await applyAuditFilters(sb.from("audit_log").select("id, role, action, entity, entity_id, detail, at", { count: "exact" }), f, { hideViews: true })
    .order("at", { ascending: false }).order("id", { ascending: false }).range(from, to);
  if (res.error?.code === "PGRST103" && page > 1) redirect(here(1)); // a page past the end (hand-typed URL)
  const rows = (res.data ?? []) as Row[];
  const total = res.count ?? rows.length;
  const exportHref = hrefWith("/app/audit/export", filterParams(f));
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <PageHeader title="Audit log" description="Who opened or changed what, and when (South African time). Details list ids, counts and field names, never what was written." actions={<AnchorButton variant="secondary" href={exportHref}>Download as CSV</AnchorButton>} />

      <form method="get" action="/app/audit" role="search" aria-label="Filter the audit log" className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-40 flex-1 [&>div]:mb-0">
          <Select id="prefix" label="Action" defaultValue={f.prefix}>
            <option value="">Any action</option>{AUDIT_PREFIXES.map((p) => <option key={p} value={p}>{p}.*</option>)}
          </Select>
        </div>
        <div className="min-w-40 flex-1 [&>div]:mb-0">
          <Select id="entity" label="Record type" defaultValue={f.entity}>
            <option value="">Any record</option>{AUDIT_ENTITIES.map((e) => <option key={e} value={e}>{e.replace(/_/g, " ")}</option>)}
          </Select>
        </div>
        <div className="min-w-40 flex-1 [&>div]:mb-0">
          <Select id="role" label="Who (role)" defaultValue={f.role}>
            <option value="">Anyone</option>{AUDIT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] ?? "System"}</option>)}
          </Select>
        </div>
        <div className="min-w-40 flex-1 [&>div]:mb-0"><Input id="from" label="From (date)" type="date" defaultValue={f.from} /></div>
        <div className="min-w-40 flex-1 [&>div]:mb-0"><Input id="to" label="To (date)" type="date" defaultValue={f.to} /></div>
        <Button type="submit" variant="secondary">Apply</Button>
        {filtered && <LinkButton variant="quiet" href="/app/audit">Clear</LinkButton>}
      </form>

      {res.error && <Notice tone="error">We could not load the audit log. Please refresh the page.</Notice>}
      {!res.error && rows.length === 0 && <Notice tone="info">{filtered ? "Nothing matches these filters." : "Nothing has been recorded yet."}</Notice>}

      {rows.length > 0 && (
        <>
          <div role="region" aria-label="Audit log table" tabIndex={0} className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Audit log, newest first</caption>
              <thead className="bg-sunk text-sm text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Time</th>
                  <th scope="col" className="px-4 py-3 font-medium">Who</th>
                  <th scope="col" className="px-4 py-3 font-medium">Action</th>
                  <th scope="col" className="px-4 py-3 font-medium">Record</th>
                  <th scope="col" className="px-4 py-3 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="px-4 py-3 whitespace-nowrap">{auditTime(r.at)}</td>
                    <td className="px-4 py-3">{r.role ? (ROLE_LABEL[r.role] ?? r.role) : "System"}</td>
                    <td className="px-4 py-3">
                      <code className="text-sm">{r.action}</code>
                      {auditActionText(r.action) !== r.action && <span className="block text-sm text-ink-muted">{auditActionText(r.action)}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {r.entity ? r.entity.replace(/_/g, " ") : <span className="text-ink-muted">None</span>}
                      {shortEntityId(r.entity_id) && <span className="block text-sm text-ink-muted" title={r.entity_id ?? undefined}>{shortEntityId(r.entity_id)}</span>}
                    </td>
                    <td className="break-words px-4 py-3 text-sm text-ink-muted">{auditDetailSummary(r.detail) || "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pages={pages} total={total} from={from} to={to} hrefFor={here} label="Audit log pages" />
          <p className="mt-3 text-sm text-ink-muted">Opening this log is recorded as audit.view; those rows are left out of this list unless you choose the audit action filter. The CSV holds the same filtered rows, newest first, up to {EXPORT_MAX_ROWS.toLocaleString("en-ZA")}. Downloading it is recorded in this log.</p>
        </>
      )}
    </>
  );
}
