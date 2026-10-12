import Link from "next/link";
import { isOverdue, PAYER_LABEL } from "@/lib/billing/list";
import { formatZar } from "@/lib/money";
import { sastDayShort } from "@/lib/time";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { StatusChip } from "@/components/ui/status-chip";
import type { TabContext } from "./tabs";

type Row = { id: string; number: string; status: string; payer_type: string; issue_date: string; due_date: string; total_cents: number; outstanding_cents: number };

/** This patient's invoices (newest first) with status and what is still owed, and the way to start a new one. Psychologist and admin (the tab is hidden for others; RLS decides the data). */
export async function BillingTab({ patient, sb, today }: TabContext) {
  const { data, error } = await sb.from("invoice_balances")
    .select("id, number, status, payer_type, issue_date, due_date, total_cents, outstanding_cents")
    .eq("patient_id", patient.id).order("created_at", { ascending: false }).limit(200);
  if (error) return <Notice tone="error">We could not load the invoices for this patient. Please refresh the page.</Notice>;
  const rows = (data ?? []) as Row[];
  const owed = rows.reduce((s, r) => s + r.outstanding_cents, 0);

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-ink-muted">Outstanding on open invoices: <strong className="text-ink">{formatZar(owed)}</strong>.</p>
        <LinkButton href={`/app/billing/new?patient=${patient.id}`}>New invoice</LinkButton>
      </div>
      {rows.length === 0 ? <Notice tone="info">No invoices have been made for this patient yet.</Notice> : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Invoices for this patient, newest first</caption>
            <thead className="bg-sunk text-sm text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Invoice</th>
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
                  <td className="px-4 py-3 whitespace-nowrap">{sastDayShort(r.due_date, true)}</td>
                  <td className="px-4 py-3">{PAYER_LABEL[r.payer_type] ?? r.payer_type}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(r.total_cents)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(r.outstanding_cents)}</td>
                  <td className="px-4 py-3"><div className="flex flex-wrap gap-1.5"><StatusChip status={r.status} />{isOverdue(r, today) && <StatusChip status="overdue" />}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
