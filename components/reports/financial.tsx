import Link from "next/link";
import type { Role } from "@/lib/auth/roles";
import { AGEING_LABEL, type AgeingBucket } from "@/lib/reports/ageing";
import { METHOD_LABEL, PAYER_LABEL } from "@/lib/billing/list";
import { DEFINITIONS } from "@/lib/reports/definitions";
import { monthLabel } from "@/lib/reports/format";
import { exportHref } from "@/lib/reports/links";
import type { Financial } from "@/lib/reports/load";
import { sastDayShort } from "@/lib/time";
import { rangeText, type Period } from "@/lib/reports/periods";
import { formatZar } from "@/lib/money";
import { AnchorButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Bar, DataTable, Figure, ReportSection } from "./ui";

const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((t, r) => t + f(r), 0);
const money = (c: number) => <span className="whitespace-nowrap">{formatZar(c)}</span>;

export function FinancialReport({ f, role, period }: { f: Financial; role: Role; period: Period }) {
  const vat = f.vatRegistered.ok && f.vatRegistered.data;
  const canSeeNames = role !== "bookkeeper";
  const inc = f.income, mth = f.methods, st = f.sessionTypes, age = f.ageing, deb = f.debtors;
  const incomeEmpty = inc.ok && sum(inc.data, (r) => r.invoicedCents + r.receivedCents + r.creditCents) === 0;
  const maxInv = inc.ok ? Math.max(0, ...inc.data.map((r) => r.invoicedCents)) : 0;
  const mthTotal = mth.ok ? sum(mth.data, (r) => r.receivedCents) : 0;
  const stMax = st.ok ? Math.max(0, ...st.data.map((r) => r.invoicedCents)) : 0;
  const ageMax = age.ok ? Math.max(0, ...age.data.map((r) => r.outstandingCents)) : 0;

  return (
    <>
      <ReportSection id="income" title="Income by month" intro={`Invoiced, received and credit notes, ${rangeText(period)}.`} exportHref={exportHref("income_by_month", period)}
        state={!inc.ok ? "failed" : incomeEmpty ? "empty" : "ok"} emptyText="No invoices, payments or credit notes in this period." definition={DEFINITIONS.incomeByMonth}>
        {inc.ok && (
          <DataTable caption="Income by month" rows={inc.data} rowKey={(r) => r.month}
            cols={[
              { header: "Month", cell: (r) => monthLabel(r.month) },
              { header: "Invoices", num: true, cell: (r) => r.invoices, total: sum(inc.data, (r) => r.invoices) },
              { header: "Invoiced", num: true, cell: (r) => <>{money(r.invoicedCents)}<Bar value={r.invoicedCents} max={maxInv} /></>, total: money(sum(inc.data, (r) => r.invoicedCents)) },
              ...(vat ? [{ header: "VAT included", num: true, cell: (r: (typeof inc.data)[number]) => money(r.vatCents), total: money(sum(inc.data, (r) => r.vatCents)) },
                { header: "VAT on credit notes", num: true, cell: (r: (typeof inc.data)[number]) => money(r.vatCreditedCents), total: money(sum(inc.data, (r) => r.vatCreditedCents)) }] : []),
              { header: "Received", num: true, cell: (r) => <>{money(r.receivedCents)}<Bar value={r.receivedCents} max={maxInv} tone="blue" /></>, total: money(sum(inc.data, (r) => r.receivedCents)) },
              { header: "Credit notes", num: true, cell: (r) => money(r.creditCents), total: money(sum(inc.data, (r) => r.creditCents)) },
            ]} />
        )}
      </ReportSection>

      <ReportSection id="methods" title="Received by payment method" exportHref={exportHref("income_by_method", period)}
        state={!mth.ok ? "failed" : mthTotal === 0 ? "empty" : "ok"} emptyText="No payments were received in this period." definition={DEFINITIONS.incomeByMethod}>
        {mth.ok && (
          <DataTable caption="Received by payment method" rows={mth.data} rowKey={(r) => r.method}
            cols={[
              { header: "Method", cell: (r) => METHOD_LABEL[r.method] ?? r.method },
              { header: "Payments", num: true, cell: (r) => r.payments, total: sum(mth.data, (r) => r.payments) },
              { header: "Received", num: true, cell: (r) => <>{money(r.receivedCents)}<Bar value={r.receivedCents} max={mthTotal} /></>, total: money(mthTotal) },
            ]} />
        )}
      </ReportSection>

      <ReportSection id="session-types" title="Invoiced by session type" exportHref={exportHref("income_by_session_type", period)}
        state={!st.ok ? "failed" : st.data.length === 0 ? "empty" : "ok"} emptyText="No invoices were issued in this period." definition={DEFINITIONS.incomeBySessionType}>
        {st.ok && (
          <DataTable caption="Invoiced by session type" rows={st.data} rowKey={(r) => r.sessionType}
            cols={[
              { header: "Session type", cell: (r) => r.sessionType },
              { header: "Invoices", num: true, cell: (r) => r.invoices, total: sum(st.data, (r) => r.invoices) },
              { header: "Invoiced", num: true, cell: (r) => <>{money(r.invoicedCents)}<Bar value={r.invoicedCents} max={stMax} /></>, total: money(sum(st.data, (r) => r.invoicedCents)) },
            ]} />
        )}
      </ReportSection>

      <ReportSection id="debtors" title="Debtors by age" intro={`Money still owed on issued invoices as at ${rangeText({ from: f.asOf, to: f.asOf })}.`} exportHref={exportHref("debtors", period)}
        state={!age.ok ? "failed" : f.debtorsProblem || sum(age.data, (r) => r.outstandingCents) === 0 ? "empty" : "ok"} emptyText={f.debtorsProblem ?? "Nothing is outstanding."} definition={DEFINITIONS.debtors}>
        {age.ok && (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-3">
              <Figure label="Outstanding in total" value={formatZar(sum(age.data, (r) => r.outstandingCents))} />
              <Figure label="Medical aid still to pay" value={formatZar(sum(age.data, (r) => r.schemeCents))} />
              <Figure label="Patients still to pay" value={formatZar(sum(age.data, (r) => r.patientCents))} />
            </div>
            <DataTable caption="Debtors by age" rows={age.data} rowKey={(r) => r.bucket}
              cols={[
                { header: "Age", cell: (r) => AGEING_LABEL[r.bucket as AgeingBucket] ?? r.bucket },
                { header: "Invoices", num: true, cell: (r) => r.invoices, total: sum(age.data, (r) => r.invoices) },
                { header: "Outstanding", num: true, cell: (r) => <>{money(r.outstandingCents)}<Bar value={r.outstandingCents} max={ageMax} /></>, total: money(sum(age.data, (r) => r.outstandingCents)) },
                { header: "Medical aid owes", num: true, cell: (r) => money(r.schemeCents), total: money(sum(age.data, (r) => r.schemeCents)) },
                { header: "Patient owes", num: true, cell: (r) => money(r.patientCents), total: money(sum(age.data, (r) => r.patientCents)) },
              ]} />
          </>
        )}
      </ReportSection>

      <ReportSection id="debtor-list" title="Open invoices" intro="Oldest due date first." state={!deb.ok ? "failed" : deb.data.rows.length === 0 ? "empty" : "ok"}
        emptyText={f.debtorsProblem ?? "There are no open invoices."} definition="One line per invoice that is still owing, with the same figures as the age table above.">
        {deb.ok && (
          <>
            {canSeeNames && deb.data.names === null && deb.data.rows.length > 0 && <p className="mb-3 text-ink-muted">Patient names could not be loaded just now. Refresh the page to try again.</p>}
            <DataTable caption="Open invoices" rows={deb.data.rows} rowKey={(r) => r.invoiceNumber}
              cols={[
                { header: "Invoice", cell: (r) => <Link href={`/app/billing?q=${encodeURIComponent(r.invoiceNumber)}`}>{r.invoiceNumber}</Link> },
                ...(canSeeNames ? [{
                  header: "Patient",
                  cell: (r: (typeof deb.data.rows)[number]) => r.patientId && deb.data.names?.[r.patientId]
                    ? <Link href={`/app/patients/${r.patientId}?tab=billing`}>{deb.data.names[r.patientId]}</Link> : <span className="text-ink-muted">Name unavailable</span>,
                }] : []),
                { header: "Due", cell: (r) => sastDayShort(r.dueDate, true) },
                { header: "Days overdue", num: true, cell: (r) => (r.daysOverdue > 0 ? r.daysOverdue : "Not yet due") },
                { header: "Payer", cell: (r) => PAYER_LABEL[r.payerType] ?? r.payerType },
                { header: "Outstanding", num: true, cell: (r) => money(r.outstandingCents) },
                { header: "Medical aid owes", num: true, cell: (r) => money(r.schemeCents) },
                { header: "Patient owes", num: true, cell: (r) => money(r.patientCents) },
              ]} />
            {deb.data.total > deb.data.rows.length && (
              <p className="mt-3 text-sm text-ink-muted">Showing the {deb.data.rows.length} oldest of {deb.data.total} open invoices. The CSV download above has all of them.</p>
            )}
          </>
        )}
      </ReportSection>

      <section aria-labelledby="accountant-h" className="mb-10 rounded-card border border-line bg-surface p-5 shadow-card">
        <h2 id="accountant-h" className="text-xl">Accountant export</h2>
        <p className="mt-1 max-w-2xl text-ink-muted">Every payment and credit note in the period as a spreadsheet, for your accountant. It has no patient names.</p>
        <Notice tone="info" title="About references" className="mt-4 mb-3">
          <p>The reference column is copied from bank statements and card slips, and a payer may have put their name in it. Check it before you send the file on.</p>
        </Notice>
        <AnchorButton href={exportHref("transactions", period)} variant="secondary" aria-label="Download the accountant export as CSV">Download accountant export (CSV)</AnchorButton>
        <p className="mt-3 max-w-3xl text-sm text-ink-muted"><span className="font-medium text-ink">What this means. </span>{DEFINITIONS.transactions}</p>
      </section>
    </>
  );
}
