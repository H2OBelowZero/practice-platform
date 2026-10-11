import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { apptId } from "@/lib/appointments/input";
import { isActiveStatus } from "@/lib/appointments/rules";
import { getSlots } from "@/lib/booking/availability";
import { realDateParam } from "@/lib/booking/input";
import { durationLabel, formatLabel } from "@/lib/booking/labels";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel, sastTime } from "@/lib/time";
import { ActionForm } from "@/components/ui/action-form";
import { Button, LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { SlotPicker } from "@/components/ui/slot-picker";
import { rescheduleAppointmentStaff, rescheduleAppointmentStaffAt } from "../../actions";

export const metadata = { title: "Reschedule appointment" };

type Row = {
  id: string; session_type_id: string; starts_at: string; status: string;
  patients: { first_name: string; last_name: string } | null;
  session_types: { name: string; duration_min: number; format: string } | null;
};

/** Staff reschedule: pick a free slot like a patient would, or use "override hours" to set any date and time (staff are exempt from availability rules). */
export default async function StaffReschedulePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const id = apptId.safeParse((await params).id);
  if (!id.success) notFound();

  const sb = await supabaseServer();
  const { data } = await sb.from("appointments")
    .select("id, session_type_id, starts_at, status, patients(first_name, last_name), session_types(name, duration_min, format)")
    .eq("id", id.data).maybeSingle();
  const appt = data as unknown as Row | null;
  if (!appt) notFound();
  if (!isActiveStatus(appt.status)) redirect(`/app/calendar/${appt.id}`);

  const date = realDateParam((await searchParams).date) ?? sastDate(appt.starts_at);
  let slots: string[] = [];
  let slotsFailed = false;
  try { slots = await getSlots(appt.session_type_id, date); } catch { slotsFailed = true; }
  const t = appt.session_types;

  return (
    <>
      <PageHeader title="Reschedule appointment" description={<Link href={`/app/calendar/${appt.id}`}>Back to this appointment</Link>} />
      <Card className="mb-6">
        <p>
          <strong>{appt.patients ? `${appt.patients.first_name} ${appt.patients.last_name}` : "Patient"}</strong><br />
          {t?.name ?? "Session"}{t && <> · {durationLabel(t.duration_min)} · {formatLabel(t.format)}</>}<br />
          Currently {sastDateLabel(appt.starts_at)} at {sastTime(appt.starts_at)} (SAST).
        </p>
      </Card>

      <section aria-labelledby="free-h" className="mb-10">
        <h2 id="free-h" className="mb-3">Choose a free time</h2>
        <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1"><Input id="date" label="Date" type="date" required defaultValue={date} /></div>
          <Button type="submit" variant="secondary" className="mb-5">Show available times</Button>
        </form>
        {slotsFailed && <Notice tone="error">We could not load the available times. Please try again, or use override hours below.</Notice>}
        {!slotsFailed && (
          <>
            <p className="mb-3 text-sm text-ink-muted">{sastDateLabel(date)}. Times are SAST. Choosing a time moves the appointment straight away and emails the patient. Its current time is held, so it may not be listed.</p>
            {slots.length === 0
              ? <Notice tone="info">No free times on this day within working hours. Use override hours below to set any time.</Notice>
              : <SlotPicker action={rescheduleAppointmentStaff} id={appt.id} legend="Available times" slots={slots.map((iso) => ({ iso, label: sastTime(iso) }))} />}
          </>
        )}
      </section>

      <section aria-labelledby="override-h">
        <h2 id="override-h" className="mb-3">Override hours</h2>
        <Card>
          <p className="mb-4 text-ink-muted">Set any date and time, including outside working hours or in the past. Only overlaps with another appointment are refused.</p>
          <ActionForm action={rescheduleAppointmentStaffAt} args={[appt.id]} submitLabel="Move to this time" pendingLabel="Moving…">
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Input id="override-date" name="date" label="Date" type="date" required defaultValue={sastDate(appt.starts_at)} />
              <Input id="override-time" name="time" label="Time (SAST)" type="time" step={300} required defaultValue={sastTime(appt.starts_at)} />
            </div>
          </ActionForm>
        </Card>
      </section>
      <p className="mt-8"><LinkButton href={`/app/calendar/${appt.id}`} variant="quiet">Keep the current time</LinkButton></p>
    </>
  );
}
