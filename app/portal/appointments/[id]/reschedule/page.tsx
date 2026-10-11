import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { apptId } from "@/lib/appointments/input";
import { guardianMayBook, insideCancellationWindow, portalMayChange } from "@/lib/appointments/rules";
import { formatZar } from "@/lib/money";
import { getPractice } from "@/lib/practice";
import { getSlots } from "@/lib/booking/availability";
import { BOOKING_ERROR_TEXT, isBookingErrorCode } from "@/lib/booking/errors";
import { durationLabel, formatLabel } from "@/lib/booking/labels";
import { realDateParam } from "@/lib/booking/input";
import { supabaseServer } from "@/lib/supabase/server";
import { bookingDateRange, isBookableDate, sastDate, sastDateLabel, sastTime } from "@/lib/time";
import { Button, LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { SlotPicker } from "@/components/ui/slot-picker";
import { rescheduleAppointment } from "../../actions";

export const metadata = { title: "Reschedule appointment" };

type Row = {
  id: string; patient_id: string; session_type_id: string; starts_at: string; status: string;
  session_types: { name: string; duration_min: number; format: string } | null;
  patients: { first_name: string; user_id: string | null } | null;
};

export default async function ReschedulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string; e?: string }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const id = apptId.safeParse((await params).id);
  if (!id.success) notFound();
  const sp = await searchParams;

  const sb = await supabaseServer();
  const { data } = await sb.from("appointments")
    .select("id, patient_id, session_type_id, starts_at, status, session_types(name, duration_min, format), patients(first_name, user_id)")
    .eq("id", id.data).maybeSingle();
  const appt = data as unknown as Row | null;
  if (!appt) notFound(); // someone else's appointment: RLS returned nothing

  const now = new Date();
  if (!portalMayChange({ status: appt.status, startsAt: new Date(appt.starts_at) }, now)) redirect(`/portal/appointments/${appt.id}`);
  if (appt.patients?.user_id !== me.userId) {
    const { data: g } = await sb.from("guardianships").select("permissions, valid_from, valid_to").eq("guardian_user_id", me.userId).eq("patient_id", appt.patient_id);
    if (!(g ?? []).some((x) => guardianMayBook(x, sastDate(now)))) redirect(`/portal/appointments/${appt.id}`);
  }

  // Policy first (0010): inside the cancellation window a patient cannot move the appointment, so no slot buttons are offered.
  const practice = await getPractice();
  const windowHours = practice?.cancellation_window_hours ?? 24;
  const feeCents = practice?.late_cancel_fee_cents ?? 0;
  if (insideCancellationWindow(new Date(appt.starts_at), now, windowHours)) {
    return (
      <>
        <PageHeader title="Reschedule appointment" description={<Link href={`/portal/appointments/${appt.id}`}>Back to this appointment</Link>} />
        <Notice tone="warning" title="This appointment cannot be moved online">
          This appointment is inside the cancellation window ({windowHours} hours before it starts). To change it, cancel it{feeCents > 0 ? ` (a fee of ${formatZar(feeCents)} may apply)` : ""} or contact the practice.
        </Notice>
        <div className="flex flex-wrap gap-3">
          <LinkButton href={`/portal/appointments/${appt.id}?confirm=cancel#cancel-panel`} variant="secondary">Cancel this appointment</LinkButton>
          <LinkButton href={`/portal/appointments/${appt.id}`} variant="quiet">Keep the appointment</LinkButton>
        </div>
      </>
    );
  }

  const range = bookingDateRange(now);
  const date = realDateParam(sp.date);
  const dateOk = date !== undefined && isBookableDate(date, now);
  let slots: string[] = [];
  let slotsFailed = false;
  if (dateOk) { try { slots = await getSlots(appt.session_type_id, date); } catch { slotsFailed = true; } }
  const error = isBookingErrorCode(sp.e) ? BOOKING_ERROR_TEXT[sp.e] : undefined;
  const t = appt.session_types;

  return (
    <>
      <PageHeader title="Reschedule appointment" description={<Link href={`/portal/appointments/${appt.id}`}>Back to this appointment</Link>} />
      <Card className="mb-6">
        <p>
          <strong>{t?.name ?? "Session"}</strong>{t && <> · {durationLabel(t.duration_min)} · {formatLabel(t.format)}</>}<br />
          Currently {sastDateLabel(appt.starts_at)} at {sastTime(appt.starts_at)} (SAST).
        </p>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <form method="get" className="mb-8 flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <Input id="date" label="New date" type="date" required min={range.min} max={range.max} defaultValue={date ?? range.min}
                 hint={`Available from ${sastDateLabel(range.min)} up to 60 days ahead.`} />
        </div>
        <Button type="submit" variant="secondary" className="mb-5">Show available times</Button>
      </form>
      {date !== undefined && !dateOk && <Notice tone="warning">Please choose a date between {sastDateLabel(range.min)} and {sastDateLabel(range.max)}.</Notice>}
      {slotsFailed && <Notice tone="error">We could not load the available times. Please try again in a moment.</Notice>}
      {dateOk && !slotsFailed && (
        <section aria-labelledby="slots-h">
          <h2 id="slots-h" className="mb-1">{sastDateLabel(date)}</h2>
          <p className="mb-4 text-sm text-ink-muted">Times are South African Standard Time (SAST). Choosing a time moves your appointment straight away. Your current time is held for you, so it may not be listed.</p>
          {slots.length === 0
            ? <Notice tone="info">There are no free times on this day. Please try another date.</Notice>
            : <SlotPicker action={rescheduleAppointment} id={appt.id} legend="Available times" slots={slots.map((iso) => ({ iso, label: sastTime(iso) }))} />}
        </section>
      )}
      <p className="mt-8"><LinkButton href={`/portal/appointments/${appt.id}`} variant="quiet">Keep the current time</LinkButton></p>
    </>
  );
}
