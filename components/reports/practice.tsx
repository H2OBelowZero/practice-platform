import Link from "next/link";
import type { Section } from "@/lib/dashboard/shape";
import { DEFINITIONS } from "@/lib/reports/definitions";
import { formatPercent, minutesText, monthLabel } from "@/lib/reports/format";
import { ACTIVITY_LABEL, claimStatusLabel, consentLabel } from "@/lib/reports/labels";
import { exportHref } from "@/lib/reports/links";
import type { Period } from "@/lib/reports/periods";
import type { Activity, AppointmentRow, Compliance } from "@/lib/reports/queries";
import { Bar, DataTable, Figure, ReportSection } from "./ui";

const max = (xs: number[]) => Math.max(0, ...xs);
const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((t, r) => t + f(r), 0);

export function AppointmentsReport({ s, period }: { s: Section<AppointmentRow[]>; period: Period }) {
  const total = s.ok ? s.data.find((r) => r.isTotal) : undefined;
  const types = s.ok ? s.data.filter((r) => !r.isTotal) : [];
  const empty = s.ok && (total?.booked ?? 0) + (total?.cancelled ?? 0) === 0;
  const m = max(types.map((r) => r.booked));
  return (
    <ReportSection id="appointments" title="Appointments" intro="How the diary was used in this period." exportHref={exportHref("appointments", period)}
      state={!s.ok ? "failed" : empty ? "empty" : "ok"} emptyText="There were no sessions in this period." definition={DEFINITIONS.appointments}>
      {s.ok && total && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Figure label="Utilisation" value={formatPercent(total.utilisation)}
              note={total.availableMinutes === null ? "No working hours are set for this period." : `${minutesText(total.bookedMinutes)} booked of ${minutesText(total.availableMinutes)} available`} />
            <Figure label="No-show rate" value={formatPercent(total.noShowRate)} note={`${total.noShow} of ${total.attended + total.noShow} sessions that were due`} />
            <Figure label="Cancellation rate" value={formatPercent(total.cancellationRate)} note={`${total.cancelled} cancelled, ${total.lateCancelled} of them late`} />
          </div>
          <DataTable caption="Appointments by session type" rows={s.data} rowKey={(r) => (r.isTotal ? "__total" : r.sessionType)} totalLabel="All session types"
            cols={[
              { header: "Session type", cell: (r) => r.sessionType },
              { header: "Booked", num: true, cell: (r) => <>{r.booked}{!r.isTotal && <Bar value={r.booked} max={m} />}</> },
              { header: "Attended", num: true, cell: (r) => r.attended },
              { header: "No-shows", num: true, cell: (r) => r.noShow },
              { header: "Cancelled", num: true, cell: (r) => r.cancelled },
              { header: "Late cancellations", num: true, cell: (r) => r.lateCancelled },
              { header: "Time booked", num: true, cell: (r) => minutesText(r.bookedMinutes) },
              { header: "No-show rate", num: true, cell: (r) => formatPercent(r.noShowRate) },
              { header: "Cancellation rate", num: true, cell: (r) => formatPercent(r.cancellationRate) },
            ]} />
        </>
      )}
    </ReportSection>
  );
}

export function ActivityReport({ s, period }: { s: Section<Activity>; period: Period }) {
  const a = s.ok ? s.data : null;
  const empty = a !== null && a.newPatients.every((x) => x.n === 0) && a.caseload === 0 && a.tasksCreated === 0 && a.claims.length === 0 && a.payfastOpen === 0;
  const mp = a ? max(a.newPatients.map((x) => x.n)) : 0, rp = a ? max(a.referrals.map((x) => x.n)) : 0, cp = a ? max(a.claims.map((x) => x.n)) : 0;
  return (
    <ReportSection id="activity" title="Practice activity" intro="New patients, caseload, follow-up and claims." exportHref={exportHref("activity", period)}
      state={!a ? "failed" : empty ? "empty" : "ok"} emptyText="Nothing happened in this period." definition={DEFINITIONS.activity}>
      {a && (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <Figure label="Active caseload" value={a.caseload} note="Patients seen in the last 90 days of the period" />
            <Figure label="Follow-up tasks done" value={formatPercent(a.completionRate)} note={`${a.tasksCompleted} of ${a.tasksCreated} created in the period`} />
            <Figure label="PayFast payments to match" value={a.payfastOpen} note={a.payfastOpen > 0 ? <Link href="/app/tasks?group=payfast">Open the tasks</Link> : "None waiting"} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <DataTable caption="New patients by month" rows={a.newPatients} rowKey={(r) => r.month}
              cols={[
                { header: "Month", cell: (r) => monthLabel(r.month) },
                { header: "New patients", num: true, cell: (r) => <>{r.n}<Bar value={r.n} max={mp} /></>, total: sum(a.newPatients, (r) => r.n) },
              ]} />
            {a.referrals.length === 0 ? <p className="text-ink-muted">No new patients in this period, so no referral sources.</p> : (
              <DataTable caption="Referral sources of new patients" rows={a.referrals} rowKey={(r) => r.label}
                cols={[
                  { header: "Referral source", cell: (r) => r.label },
                  { header: "Patients", num: true, cell: (r) => <>{r.n}<Bar value={r.n} max={rp} tone="blue" /></>, total: sum(a.referrals, (r) => r.n) },
                ]} />
            )}
            {a.claims.length === 0 ? <p className="text-ink-muted">No claims were created in this period.</p> : (
              <DataTable caption="Claims created, by status" rows={a.claims} rowKey={(r) => r.status}
                cols={[
                  { header: "Claim status", cell: (r) => claimStatusLabel(r.status) },
                  { header: "Claims", num: true, cell: (r) => <>{r.n}<Bar value={r.n} max={cp} /></>, total: sum(a.claims, (r) => r.n) },
                ]} />
            )}
          </div>
        </>
      )}
    </ReportSection>
  );
}

export function ComplianceReport({ s, period }: { s: Section<Compliance>; period: Period }) {
  const c = s.ok ? s.data : null;
  const mx = c ? max(c.activity.map((x) => x.n)) : 0;
  return (
    <ReportSection id="compliance" title="Compliance" intro="These figures describe system activity, not clinical outcomes." exportHref={exportHref("compliance", period)}
      state={c ? "ok" : "failed"} definition={DEFINITIONS.compliance}>
      {c && (
        <>
          <DataTable caption="System activity in the period" rows={c.activity} rowKey={(r) => r.key}
            cols={[
              { header: "Activity", cell: (r) => ACTIVITY_LABEL[r.key] ?? r.key },
              { header: "Times", num: true, cell: (r) => <>{r.n}<Bar value={r.n} max={mx} /></> },
            ]} />
          <h3 className="mt-6 mb-2 text-lg">Consent on file now</h3>
          <DataTable caption="Consent by purpose, for patients who are not archived" rows={c.consent} rowKey={(r) => r.purpose}
            cols={[
              { header: "Purpose", cell: (r) => consentLabel(r.purpose) },
              { header: "Given", num: true, cell: (r) => r.granted },
              { header: "Withdrawn", num: true, cell: (r) => r.withdrawn },
              { header: "Not recorded", num: true, cell: (r) => r.none },
            ]} />
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <Figure label="Notifications that failed to send" value={c.failedNotifications} note="Tasks raised in the period" />
            <Figure label="PayFast notifications refused" value={c.payfastRejected} note="Passed the signature check, then rejected" />
          </div>
        </>
      )}
    </ReportSection>
  );
}
