import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { isActiveStatus, guardianMayBook, insideCancellationWindow, portalMayChange } from "@/lib/appointments/rules";
import { getPractice } from "@/lib/practice";
import { noticeText } from "@/lib/appointments/notices";
import { durationLabel, formatLabel } from "@/lib/booking/labels";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel, sastTime } from "@/lib/time";
import { cancelReasonText } from "@/lib/appointments/events";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";

export const metadata = { title: "Appointments" };

type Row = {
  id: string; patient_id: string; starts_at: string; ends_at: string; status: string; cancel_reason: string | null;
  session_types: { name: string; duration_min: number; format: string } | null;
  patients: { first_name: string; user_id: string | null } | null;
};

/** Patients see their own appointments, guardians those of the people they care for: all through RLS, so nobody else's ever arrives here. */
export default async function PortalAppointments({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const notice = noticeText((await searchParams).notice);
  const sb = await supabaseServer();
  const now = new Date();

  const [appts, guardianships] = await Promise.all([
    sb.from("appointments")
      .select("id, patient_id, starts_at, ends_at, status, cancel_reason, session_types(name, duration_min, format), patients(first_name, user_id)")
      .order("starts_at", { ascending: false }).limit(200),
    sb.from("guardianships").select("patient_id, permissions, valid_from, valid_to").eq("guardian_user_id", me.userId),
  ]);
  const rows = (appts.data ?? []) as unknown as Row[];
  const today = sastDate(now);
  const windowHours = (await getPractice())?.cancellation_window_hours ?? 24;
  const mayBook = new Set((guardianships.data ?? []).filter((g) => guardianMayBook(g, today)).map((g) => g.patient_id as string));

  const upcoming = rows.filter((r) => isActiveStatus(r.status) && new Date(r.starts_at) > now).reverse(); // soonest first
  const past = rows.filter((r) => !upcoming.includes(r));

  const item = (r: Row, actions: boolean) => {
    const own = r.patients?.user_id === me.userId;
    const t = r.session_types;
    const when = `${sastDateLabel(r.starts_at)} at ${sastTime(r.starts_at)}`;
    const may = actions && (own || mayBook.has(r.patient_id)) && portalMayChange({ status: r.status, startsAt: new Date(r.starts_at) }, now);
    return (
      <li key={r.id}>
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-lg"><Link href={`/portal/appointments/${r.id}`}>{when}</Link></h3>
              <p className="text-ink-muted">
                {t ? `${t.name} · ${durationLabel(t.duration_min)} · ${formatLabel(t.format)}` : "Session"} (times in SAST)
                {!own && r.patients && <> · For <strong className="text-ink">{r.patients.first_name}</strong></>}
              </p>
              {r.status === "cancelled" && cancelReasonText(r.cancel_reason) && <p className="mt-1 text-sm text-ink-muted">{cancelReasonText(r.cancel_reason)}</p>}
            </div>
            <StatusChip status={r.status} />
          </div>
          {may && (
            <div className="mt-4 flex flex-wrap gap-3">
              {!insideCancellationWindow(new Date(r.starts_at), now, windowHours) && <LinkButton href={`/portal/appointments/${r.id}/reschedule`} variant="secondary" aria-label={`Reschedule the appointment on ${when}`}>Reschedule</LinkButton>}
              <LinkButton href={`/portal/appointments/${r.id}?confirm=cancel#cancel-panel`} variant="quiet" aria-label={`Cancel the appointment on ${when}`}>Cancel</LinkButton>
            </div>
          )}
        </Card>
      </li>
    );
  };

  return (
    <>
      <PageHeader title="Appointments" description="Your upcoming and past sessions." actions={<LinkButton href="/book">Book an appointment</LinkButton>} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {appts.error && <Notice tone="error">We could not load your appointments. Please refresh the page.</Notice>}

      <section aria-labelledby="upcoming-h" className="mb-10">
        <h2 id="upcoming-h" className="mb-4">Upcoming</h2>
        {upcoming.length === 0 ? <Notice tone="info">You have no upcoming appointments.</Notice> : <ul className="grid list-none gap-4 p-0">{upcoming.map((r) => item(r, true))}</ul>}
      </section>

      <section aria-labelledby="past-h">
        <h2 id="past-h" className="mb-4">Past and cancelled</h2>
        {past.length === 0 ? <p className="text-ink-muted">Nothing here yet.</p> : <ul className="grid list-none gap-4 p-0">{past.map((r) => item(r, false))}</ul>}
      </section>
    </>
  );
}
