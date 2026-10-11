import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { cancelReasonText } from "@/lib/appointments/events";
import { apptId } from "@/lib/appointments/input";
import { freeCancelUntil, guardianMayBook, insideCancellationWindow, portalMayChange } from "@/lib/appointments/rules";
import { cancellationOutcome } from "@/lib/booking/policy";
import { durationLabel, formatLabel } from "@/lib/booking/labels";
import { formatZar } from "@/lib/money";
import { getPractice } from "@/lib/practice";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel, sastTime } from "@/lib/time";
import { ActionButton, FocusOnMount } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { cancelAppointment } from "../actions";

export const metadata = { title: "Appointment" };

type Row = {
  id: string; patient_id: string; starts_at: string; status: string; cancel_reason: string | null;
  session_types: { name: string; duration_min: number; format: string } | null;
  patients: { first_name: string; user_id: string | null } | null;
};

/**
 * One appointment, with the cancellation outcome shown BEFORE anyone confirms. Another patient's id gives a 404 because RLS
 * returns no row. Confirmation is an inline panel (?confirm=cancel), so it works by keyboard and without any browser dialog.
 */
export default async function AppointmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ confirm?: string }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const id = apptId.safeParse((await params).id);
  if (!id.success) notFound();

  const sb = await supabaseServer();
  const { data } = await sb.from("appointments")
    .select("id, patient_id, starts_at, status, cancel_reason, session_types(name, duration_min, format), patients(first_name, user_id)")
    .eq("id", id.data).maybeSingle();
  const appt = data as unknown as Row | null;
  if (!appt) notFound();

  const now = new Date();
  const startsAt = new Date(appt.starts_at);
  const own = appt.patients?.user_id === me.userId;
  let mayBook = own;
  if (!own) {
    const { data: g } = await sb.from("guardianships").select("permissions, valid_from, valid_to").eq("guardian_user_id", me.userId).eq("patient_id", appt.patient_id);
    mayBook = (g ?? []).some((x) => guardianMayBook(x, sastDate(now)));
  }
  const upcoming = portalMayChange({ status: appt.status, startsAt }, now);
  const practice = await getPractice();
  const windowHours = practice?.cancellation_window_hours ?? 24;
  const outcome = cancellationOutcome({ startsAt, now, windowHours, lateFeeCents: practice?.late_cancel_fee_cents ?? 0 });
  const freeUntil = freeCancelUntil(startsAt, windowHours);
  const canMove = !insideCancellationWindow(startsAt, now, windowHours); // the database refuses a patient move inside the window (0010)
  const confirming = (await searchParams).confirm === "cancel" && upcoming && mayBook;
  const t = appt.session_types;

  const policy = outcome.late
    ? (outcome.feeCents > 0
        ? <Notice tone="warning" title="Cancelling now may incur a fee">Cancelling now may incur a fee of {formatZar(outcome.feeCents)}, because this appointment starts within {windowHours} hours. The practice will review it and let you know.</Notice>
        : <Notice tone="info" title="No fee">This appointment starts within {windowHours} hours, but the practice does not charge a fee for late cancellations.</Notice>)
    : <Notice tone="info" title="Free to cancel">You can cancel without a fee until {sastDateLabel(freeUntil)} at {sastTime(freeUntil)} (SAST). After that a late cancellation may be charged{(practice?.late_cancel_fee_cents ?? 0) > 0 ? ` (${formatZar(practice!.late_cancel_fee_cents)})` : ""}.</Notice>;

  return (
    <>
      <PageHeader title="Appointment" description={<Link href="/portal/appointments">Back to all appointments</Link>} />
      <Card className="mb-6">
        <div className="mb-5"><StatusChip status={appt.status} /></div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          {!own && appt.patients && <><dt className="text-ink-muted">For</dt><dd className="font-medium">{appt.patients.first_name}</dd></>}
          <dt className="text-ink-muted">Session</dt><dd className="font-medium">{t?.name ?? "Session"}</dd>
          <dt className="text-ink-muted">Date</dt><dd className="font-medium">{sastDateLabel(appt.starts_at)}</dd>
          <dt className="text-ink-muted">Time</dt><dd className="font-medium">{sastTime(appt.starts_at)} (SAST)</dd>
          {t && <><dt className="text-ink-muted">Duration</dt><dd className="font-medium">{durationLabel(t.duration_min)}</dd>
                  <dt className="text-ink-muted">Format</dt><dd className="font-medium">{formatLabel(t.format)}</dd></>}
        </dl>
        {appt.status === "cancelled" && cancelReasonText(appt.cancel_reason) && <p className="mt-4 text-ink-muted">{cancelReasonText(appt.cancel_reason)}.</p>}
      </Card>

      {upcoming && !mayBook && <Notice tone="info">You do not have permission to change this appointment. Please contact the practice.</Notice>}
      {!upcoming && ["requested", "tentative", "confirmed"].includes(appt.status) && (
        <Notice tone="info">This appointment has started, so it can no longer be changed online. Please contact the practice.</Notice>
      )}

      {upcoming && mayBook && (
        <>
          {policy}
          {confirming ? (
            <FocusOnMount id="cancel-panel" className="rounded-card border-2 border-danger bg-surface p-5 sm:p-6">
              <h2 className="mb-2 text-xl">Cancel this appointment?</h2>
              <p className="mb-5">
                {sastDateLabel(appt.starts_at)} at {sastTime(appt.starts_at)}. {outcome.feeCents > 0 ? `You may be charged a late cancellation fee of ${formatZar(outcome.feeCents)}.` : "There is no fee."} This cannot be undone, but you can book again at any time.
              </p>
              <div className="flex flex-wrap items-start gap-3">
                <ActionButton action={cancelAppointment} args={[appt.id]} submitLabel="Yes, cancel this appointment" pendingLabel="Cancelling…" variant="danger" />
                <LinkButton href={`/portal/appointments/${appt.id}`} variant="secondary">Keep this appointment</LinkButton>
              </div>
            </FocusOnMount>
          ) : (
            <div className="flex flex-wrap gap-3">
              {!canMove && <p className="basis-full text-sm text-ink-muted">This appointment is inside the cancellation window, so it cannot be rescheduled online. You can cancel it or contact the practice.</p>}
              {canMove && <LinkButton href={`/portal/appointments/${appt.id}/reschedule`} variant="secondary">Reschedule</LinkButton>}
              <LinkButton href={`/portal/appointments/${appt.id}?confirm=cancel#cancel-panel`} variant="quiet">Cancel appointment</LinkButton>
            </div>
          )}
        </>
      )}
    </>
  );
}
