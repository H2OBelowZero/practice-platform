import Link from "next/link";
import type { ReactNode } from "react";
import type { DashAppt, DashTask, Enquiry, MethodTotal } from "@/lib/dashboard/load";
import { groupByDay, type Section } from "@/lib/dashboard/shape";
import { METHOD_LABEL } from "@/lib/billing/list";
import { formatLabel } from "@/lib/booking/labels";
import { formatZar } from "@/lib/money";
import { taskExplanation } from "@/lib/tasks/groups";
import { taskLink } from "@/lib/tasks/links";
import { sastDate, sastDayShort, sastTime } from "@/lib/time";
import { DueText, PriorityChip } from "@/components/tasks/chips";
import { LinkButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Card } from "@/components/ui/card";
import { StatusChip } from "@/components/ui/status-chip";
import { Unavailable } from "./tiles";

function Block({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <Card>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={id} className="text-lg">{title}</h2>
          {action}
        </div>
        {children}
      </Card>
    </section>
  );
}
const Empty = ({ children }: { children: ReactNode }) => <p className="text-ink-muted">{children}</p>;
const LIST = "m-0 grid list-none gap-3 p-0";
const ROW = "flex flex-wrap items-center justify-between gap-x-4 gap-y-1";

/** Today's schedule: time, patient, session type, format, length and status; each row opens the appointment. */
export function ScheduleSection({ s }: { s: Section<DashAppt[]> }) {
  return (
    <Block id="schedule-h" title="Today's schedule" action={<Link href="/app/calendar">Open calendar</Link>}>
      {!s.ok ? <Unavailable what="today's schedule" /> : s.data.length === 0 ? <Empty>No sessions today.</Empty> : (
        <ul className={LIST} aria-label="Today's sessions">
          {s.data.map((a) => (
            <li key={a.id} className={ROW}>
              <div>
                <Link href={`/app/calendar/${a.id}`} className="font-medium">{sastTime(a.starts_at)} · {a.patientName}</Link>
                <p className="text-sm text-ink-muted">{a.typeName} · {formatLabel(a.format)} · {a.minutes} minutes</p>
              </div>
              <StatusChip status={a.status} />
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

/** Tentative booking requests, each with Confirm and Decline links to the appointment (where the decision is made). */
export function RequestsSection({ s }: { s: Section<{ total: number; items: DashAppt[] }> }) {
  return (
    <Block id="requests-h" title="Booking requests">
      {!s.ok ? <Unavailable what="booking requests" /> : s.data.items.length === 0 ? <Empty>No booking requests are waiting.</Empty> : (
        <>
          <ul className={LIST} aria-label="Booking requests">
            {s.data.items.map((a) => (
              <li key={a.id} className={ROW}>
                <div>
                  <span className="font-medium">{a.patientName}</span>
                  <p className="text-sm text-ink-muted">{sastDayShort(sastDate(a.starts_at))}, {sastTime(a.starts_at)} · {a.typeName}</p>
                  {a.past && <p className="flex items-center gap-1.5 text-sm font-semibold text-warn-ink"><Icon name="alert" />Overdue: the start time has passed and this still needs a decision</p>}
                </div>
                <div className="flex gap-2">
                  <LinkButton variant="secondary" href={`/app/calendar/${a.id}`}>Confirm<span className="sr-only"> request from {a.patientName}</span></LinkButton>
                  <LinkButton variant="quiet" href={`/app/calendar/${a.id}`}>Decline<span className="sr-only"> request from {a.patientName}</span></LinkButton>
                </div>
              </li>
            ))}
          </ul>
          {s.data.total > s.data.items.length && <p className="mt-3 text-sm text-ink-muted">Showing the first {s.data.items.length} of {s.data.total}. <Link href="/app/calendar?view=agenda&status=tentative">See all in the calendar</Link>.</p>}
        </>
      )}
    </Block>
  );
}

/** Prospect patients created in the last 14 days. */
export function EnquiriesSection({ s }: { s: Section<{ total: number; items: Enquiry[] }> }) {
  return (
    <Block id="enquiries-h" title="New patient enquiries" action={<Link href="/app/patients/new">Add a patient</Link>}>
      {!s.ok ? <Unavailable what="new enquiries" /> : s.data.items.length === 0 ? <Empty>No new enquiries in the last 14 days.</Empty> : (
        <>
          <ul className={LIST} aria-label="New patient enquiries">
            {s.data.items.map((p) => (
              <li key={p.id} className={ROW}>
                <Link href={`/app/patients/${p.id}`} className="font-medium">{p.name}</Link>
                <span className="text-sm text-ink-muted">Added {sastDayShort(sastDate(p.created_at), true)}</span>
              </li>
            ))}
          </ul>
          {s.data.total > s.data.items.length && <p className="mt-3 text-sm text-ink-muted">Showing the newest {s.data.items.length} of {s.data.total}. <Link href="/app/patients?status=prospect">See all prospects</Link>.</p>}
        </>
      )}
    </Block>
  );
}

/** The next 7 days after today, grouped by day (at most 20 sessions). */
export function UpcomingSection({ s }: { s: Section<DashAppt[]> }) {
  const groups = s.ok ? groupByDay(s.data, 20) : [];
  return (
    <Block id="upcoming-h" title="Coming up: the 7 days after today" action={<Link href="/app/calendar?view=week">Open the week</Link>}>
      {!s.ok ? <Unavailable what="upcoming sessions" /> : groups.length === 0 ? <Empty>No sessions are booked for the 7 days after today.</Empty> : (
        <div className="grid gap-4">
          {groups.map((g) => (
            <div key={g.date}>
              <h3 className="mb-1 text-base">{g.label}</h3>
              <ul className={LIST} aria-label={`Sessions on ${g.label}`}>
                {g.items.map((a) => (
                  <li key={a.id} className={ROW}>
                    <Link href={`/app/calendar/${a.id}`}>{sastTime(a.starts_at)} · {a.patientName} · {a.typeName}</Link>
                    <StatusChip status={a.status} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Block>
  );
}

/** The next 8 open tasks, each with the link taskLink() gives it (or the tasks page). */
export function TasksSection({ s, today }: { s: Section<{ next: DashTask[] }>; today: string }) {
  return (
    <Block id="tasks-h" title="Open tasks" action={<Link href="/app/tasks">All tasks</Link>}>
      {!s.ok ? <Unavailable what="your tasks" /> : s.data.next.length === 0 ? <Empty>Nothing is waiting on you. No open tasks.</Empty> : (
        <ul className={LIST} aria-label="Open tasks">
          {s.data.next.map((t) => {
            const link = taskLink(t);
            return (
              <li key={t.id}>
                <div className={ROW}>
                  <span className="font-medium">{t.title}</span>
                  <PriorityChip priority={t.priority} />
                </div>
                <p className="text-sm text-ink-muted"><DueText task={t} today={today} />{link && <> · <Link href={link.href}>{link.label}</Link></>}{!link && taskExplanation(t.source) && <> · <Link href="/app/tasks">Read more</Link></>}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

/** Money received this month so far, per method (summed in the database). */
export function PaymentsSection({ s, monthLabel }: { s: Section<MethodTotal[]>; monthLabel: string }) {
  const total = s.ok ? s.data.reduce((a, m) => a + m.totalCents, 0) : 0;
  return (
    <Block id="payments-h" title={`Payments received in ${monthLabel}`} action={<Link href="/app/billing">Open billing</Link>}>
      {!s.ok ? <Unavailable what="this month's payments" /> : s.data.length === 0 ? <Empty>No payments have been recorded this month yet.</Empty> : (
        <dl className="m-0 grid gap-2">
          {s.data.map((m) => (
            <div key={m.method} className={ROW}>
              <dt>{METHOD_LABEL[m.method] ?? m.method} <span className="text-sm text-ink-muted">({m.n} {m.n === 1 ? "payment" : "payments"})</span></dt>
              <dd className="m-0 font-medium">{formatZar(m.totalCents)}</dd>
            </div>
          ))}
          <div className={`${ROW} border-t border-line pt-2`}><dt className="font-semibold">Total</dt><dd className="m-0 font-semibold">{formatZar(total)}</dd></div>
        </dl>
      )}
    </Block>
  );
}

export function ShortcutsSection() {
  return (
    <Block id="shortcuts-h" title="Shortcuts">
      <div className="flex flex-wrap gap-3">
        <LinkButton href="/app/calendar/new">New appointment</LinkButton>
        <LinkButton variant="secondary" href="/app/patients/new">New patient</LinkButton>
        <LinkButton variant="secondary" href="/app/billing/new">New invoice</LinkButton>
        <LinkButton variant="secondary" href="/app/calendar">Open calendar</LinkButton>
      </div>
    </Block>
  );
}
