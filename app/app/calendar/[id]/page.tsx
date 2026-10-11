import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { cancelReasonText, eventText, type ApptEvent } from "@/lib/appointments/events";
import { apptId } from "@/lib/appointments/input";
import { noticeText } from "@/lib/appointments/notices";
import { calendarHref } from "@/lib/calendar/range";
import { durationLabel, formatLabel } from "@/lib/booking/labels";
import { formatZar } from "@/lib/money";
import { getPractice } from "@/lib/practice";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel, sastTime } from "@/lib/time";
import { ActionButton, ActionForm } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { LinkButton, Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { cancelAppointmentStaff, confirmAppointment, declineAppointment, markAttended, markNoShow } from "../actions";

export const metadata = { title: "Appointment" };

type Row = {
  id: string; starts_at: string; ends_at: string; status: string; cancel_reason: string | null;
  patients: { id: string; first_name: string; last_name: string } | null;
  session_types: { name: string; duration_min: number; format: string; fee_cents: number } | null;
};

const roleWord = (role: string | undefined) => (role === "patient" || role === "guardian" ? "patient or guardian" : role ?? "");

export default async function StaffAppointmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const id = apptId.safeParse((await params).id);
  if (!id.success) notFound();
  const notice = noticeText((await searchParams).notice);

  const sb = await supabaseServer();
  const { data } = await sb.from("appointments")
    .select("id, starts_at, ends_at, status, cancel_reason, patients(id, first_name, last_name), session_types(name, duration_min, format, fee_cents)")
    .eq("id", id.data).maybeSingle();
  const appt = data as unknown as Row | null;
  if (!appt) notFound();

  const { data: ev } = await sb.from("appointment_events").select("id, event, actor, detail, at").eq("appointment_id", appt.id).order("id");
  const events = (ev ?? []) as unknown as ApptEvent[];
  const actors = [...new Set(events.map((e) => e.actor).filter((a): a is string => !!a))];
  const { data: profs } = actors.length ? await sb.from("profiles").select("user_id, display_name, role").in("user_id", actors) : { data: [] };
  const who = new Map((profs ?? []).map((p) => [p.user_id as string, `${p.display_name ?? "Unnamed"} (${roleWord(p.role as string)})`]));

  const practice = await getPractice();
  const fee = practice?.late_cancel_fee_cents ?? 0;
  const started = new Date(appt.starts_at) <= new Date();
  const t = appt.session_types;
  const name = appt.patients ? `${appt.patients.first_name} ${appt.patients.last_name}` : "Unknown patient";
  const st = appt.status;
  const open = st === "tentative" || st === "requested";
  const back = calendarHref({ view: "week", date: sastDate(appt.starts_at) });

  return (
    <>
      <PageHeader title="Appointment" description={<Link href={back}>Back to the calendar</Link>} />
      {notice && <Notice tone="success">{notice}</Notice>}

      <Card className="mb-8">
        <div className="mb-5"><StatusChip status={st} /></div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-muted">Patient</dt>
          <dd className="font-medium">{appt.patients ? <Link href={`/app/patients/${appt.patients.id}`}>{name}</Link> : name}</dd>
          <dt className="text-ink-muted">Session</dt><dd className="font-medium">{t?.name ?? "Session"}</dd>
          <dt className="text-ink-muted">Date</dt><dd className="font-medium">{sastDateLabel(appt.starts_at)}</dd>
          <dt className="text-ink-muted">Time</dt><dd className="font-medium">{sastTime(appt.starts_at)} to {sastTime(appt.ends_at)} (SAST)</dd>
          {t && <><dt className="text-ink-muted">Duration</dt><dd className="font-medium">{durationLabel(t.duration_min)}</dd>
                  <dt className="text-ink-muted">Format</dt><dd className="font-medium">{formatLabel(t.format)}</dd>
                  <dt className="text-ink-muted">Fee</dt><dd className="font-medium">{formatZar(t.fee_cents)}</dd></>}
          {st === "cancelled" && cancelReasonText(appt.cancel_reason) && <><dt className="text-ink-muted">Reason</dt><dd className="font-medium">{cancelReasonText(appt.cancel_reason)}</dd></>}
        </dl>
      </Card>

      <section aria-labelledby="actions-h" className="mb-8">
        <h2 id="actions-h" className="mb-4">Actions</h2>

        {open && (
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <h3 className="mb-2 text-lg">Confirm this request</h3>
              <p className="mb-4 text-ink-muted">The patient is emailed a short confirmation (date, time and a link).</p>
              <ActionButton action={confirmAppointment} args={[appt.id]} submitLabel="Confirm appointment" pendingLabel="Confirming…" />
            </Card>
            <Card>
              <h3 className="mb-2 text-lg">Decline this request</h3>
              <ActionForm action={declineAppointment} args={[appt.id]} submitLabel="Decline request" pendingLabel="Declining…" variant="danger">
                <Textarea id="decline-reason" name="reason" label="Reason" required rows={3} maxLength={500} hint="Required. It is stored with the appointment and the patient may see it." />
              </ActionForm>
            </Card>
          </div>
        )}

        {st === "confirmed" && (
          <div className="grid gap-4">
            <Card>
              <h3 className="mb-2 text-lg">Record the outcome</h3>
              {started ? (
                <div className="flex flex-wrap items-start gap-3">
                  <ActionButton action={markAttended} args={[appt.id]} submitLabel="Mark attended" pendingLabel="Saving…" />
                  <ActionButton action={markNoShow} args={[appt.id]} submitLabel="Mark no-show" pendingLabel="Saving…" variant="secondary" />
                </div>
              ) : (
                <>
                  <p className="mb-3 text-ink-muted">Available once the appointment has started.</p>
                  <div className="flex flex-wrap gap-3"><Button disabled>Mark attended</Button><Button disabled variant="secondary">Mark no-show</Button></div>
                </>
              )}
            </Card>
            <Card>
              <h3 className="mb-2 text-lg">Move to another time</h3>
              <p className="mb-4 text-ink-muted">Pick a free time, or set any time yourself (override hours).</p>
              <LinkButton href={`/app/calendar/${appt.id}/reschedule`} variant="secondary">Reschedule</LinkButton>
            </Card>
          </div>
        )}

        {(st === "confirmed" || open) && (
          <Card className="mt-4">
            <h3 className="mb-2 text-lg">Cancel this appointment</h3>
            <p className="mb-4 text-ink-muted">The patient is emailed that it was cancelled. No fee is charged unless you tick the box.</p>
            <ActionForm action={cancelAppointmentStaff} args={[appt.id]} submitLabel="Cancel appointment" pendingLabel="Cancelling…" variant="danger">
              <Textarea id="cancel-reason" name="reason" label="Reason (optional)" rows={2} maxLength={500} hint="The patient may see this." />
              <div className="mb-5 flex items-start gap-3">
                <input id="chargeFee" name="chargeFee" type="checkbox" className="mt-1 h-6 w-6 shrink-0 accent-sage-700" />
                <label htmlFor="chargeFee" className="font-medium">
                  Charge late cancellation fee{fee > 0 ? ` (${formatZar(fee)})` : ""}
                  <span className="block text-sm font-normal text-ink-muted">Creates a task to review the fee. Nothing is invoiced automatically.</span>
                </label>
              </div>
            </ActionForm>
          </Card>
        )}

        {st === "attended" && (
          <Card>
            <h3 className="mb-2 text-lg">Billing</h3>
            <p className="mb-4 text-ink-muted">The attended session can now be invoiced.</p>
            <LinkButton href={`/app/billing/new?appointment=${appt.id}`}>Create invoice</LinkButton>
          </Card>
        )}

        {(st === "no_show" || st === "cancelled") && <p className="text-ink-muted">No further actions: this appointment is {st === "no_show" ? "recorded as a no-show" : "cancelled"}.</p>}
      </section>

      <section aria-labelledby="history-h">
        <h2 id="history-h" className="mb-4">History</h2>
        {events.length === 0 ? <p className="text-ink-muted">No history recorded.</p> : (
          <ol className="m-0 grid list-none gap-3 p-0">
            {events.map((e) => (
              <li key={e.id} className="rounded-xl border border-line bg-surface p-4">
                <p className="font-medium">{eventText(e)}</p>
                <p className="text-sm text-ink-muted">
                  {e.actor ? (who.get(e.actor) ?? "Another user") : "System"} · {sastDateLabel(e.at)} at {sastTime(e.at)} (SAST)
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
