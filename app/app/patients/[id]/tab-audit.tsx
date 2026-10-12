import { auditActionText, auditDetailText } from "@/lib/patients/audit-view";
import { hrefWith, pageCount, pageRange, parsePage } from "@/lib/patients/list";
import { sastDateLabel, sastTime } from "@/lib/time";
import { Notice } from "@/components/ui/notice";
import { Pager } from "@/components/ui/pager";
import type { TabContext } from "./tabs";

type Row = { id: number; actor_id: string | null; role: string | null; action: string; detail: unknown; at: string };

/** Everything the audit log holds about this patient (rows whose entity id is the patient or one of their form submissions), newest first. Psychologist only (also RLS). */
export async function AuditTab({ patient, sb, query }: TabContext) {
  const page = parsePage(query.apage);
  const { from, to } = pageRange(page);
  const href = (p: number) => hrefWith(`/app/patients/${patient.id}`, { tab: "audit", apage: p > 1 ? p : undefined });

  // form events (request, view, submit, return) are recorded against the submission, note events against the note, everything else against the patient
  const { data: subs } = await sb.from("form_submissions").select("id").eq("patient_id", patient.id);
  const { data: notes } = await sb.from("clinical_notes").select("id").eq("patient_id", patient.id); // note events (view, sign, addendum) are recorded against the note; the tab is psychologist-only
  const ids = [patient.id, ...(subs ?? []).map((s) => s.id as string), ...(notes ?? []).map((n) => n.id as string)];

  const res = await sb.from("audit_log").select("id, actor_id, role, action, detail, at", { count: "exact" })
    .in("entity_id", ids).order("id", { ascending: false }).range(from, to);
  if (res.error) return <Notice tone="error">We could not load the audit log. Please refresh the page.</Notice>;
  const rows = (res.data ?? []) as Row[];
  const total = res.count ?? rows.length;

  const actors = [...new Set(rows.map((r) => r.actor_id).filter((a): a is string => !!a))];
  const { data: profs } = actors.length ? await sb.from("profiles").select("user_id, display_name").in("user_id", actors) : { data: [] };
  const who = new Map((profs ?? []).map((p) => [p.user_id as string, (p.display_name as string | null) || "Unnamed user"]));

  if (rows.length === 0) return <Notice tone="info">{page > 1 ? "There are no entries on this page." : "Nothing has been recorded for this patient yet."}</Notice>;
  return (
    <>
      <p className="mb-4 max-w-2xl text-ink-muted">Who opened or changed this record, and when (South African time). Changes list the fields that changed, never what they were changed to.</p>
      <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Audit log for this patient, newest first</caption>
          <thead className="bg-sunk text-sm text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">When</th>
              <th scope="col" className="px-4 py-3 font-medium">Who</th>
              <th scope="col" className="px-4 py-3 font-medium">What</th>
              <th scope="col" className="px-4 py-3 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="px-4 py-3 whitespace-nowrap">{sastDateLabel(r.at)}<span className="block text-sm text-ink-muted">{sastTime(r.at)}</span></td>
                <td className="px-4 py-3">{r.actor_id ? (who.get(r.actor_id) ?? "Another user") : "System"}<span className="block text-sm capitalize text-ink-muted">{r.role ?? ""}</span></td>
                <td className="px-4 py-3">{auditActionText(r.action)}</td>
                <td className="break-words px-4 py-3 text-sm text-ink-muted">{auditDetailText(r.detail) || "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={pageCount(total)} total={total} from={from} to={to} hrefFor={href} label="Audit log pages" />
    </>
  );
}
