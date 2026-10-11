import { requireRole } from "@/lib/auth/session";
import { noticeText } from "@/lib/appointments/notices";
import { groupByDay, gridHours, minuteOfDay } from "@/lib/calendar/grid";
import { parseDate, parseView, rangeBoundsUtc, rangeLabel, viewRange } from "@/lib/calendar/range";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { Agenda } from "@/components/calendar/agenda";
import { TimeGrid } from "@/components/calendar/time-grid";
import { CalendarToolbar } from "@/components/calendar/toolbar";
import type { CalAppt } from "@/components/calendar/types";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";

export const metadata = { title: "Calendar" };

type Row = {
  id: string; starts_at: string; ends_at: string; status: string;
  patients: { id: string; first_name: string; last_name: string } | null;
  session_types: { name: string } | null;
};
const STATUSES = ["tentative", "confirmed", "attended", "no_show", "cancelled"];

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string; status?: string; q?: string; notice?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const sp = await searchParams;
  const now = new Date();
  const today = sastDate(now);
  const view = parseView(sp.view);
  const date = parseDate(sp.date, now);
  const status = sp.status === "all" || STATUSES.includes(sp.status ?? "") ? (sp.status ?? "") : "";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const range = viewRange(view, date);
  const { from, to } = rangeBoundsUtc(range.first, range.last);

  const sb = await supabaseServer();
  let query = sb.from("appointments")
    .select("id, starts_at, ends_at, status, patients(id, first_name, last_name), session_types(name)")
    .lt("starts_at", to).gt("ends_at", from).order("starts_at").limit(500);
  if (status === "") query = query.neq("status", "cancelled");
  else if (status !== "all") query = query.eq("status", status);
  const [apptRes, rulesRes] = await Promise.all([query, sb.from("availability_rules").select("start_time, end_time")]);

  const needle = q.toLowerCase();
  const appts: CalAppt[] = ((apptRes.data ?? []) as unknown as Row[])
    .map((r) => ({
      id: r.id, starts_at: r.starts_at, ends_at: r.ends_at, status: r.status, patientId: r.patients?.id ?? null,
      patientName: r.patients ? `${r.patients.first_name} ${r.patients.last_name}` : "Unknown patient", typeName: r.session_types?.name ?? "Session",
    }))
    .filter((a) => needle === "" || a.patientName.toLowerCase().includes(needle));

  const hours = gridHours(
    (rulesRes.data ?? []).map((r) => ({ start: r.start_time as string, end: r.end_time as string })),
    range.days.flatMap((d) => appts.filter((a) => sastDate(a.starts_at) === d).map((a) => ({ startMin: minuteOfDay(a.starts_at, d), endMin: minuteOfDay(a.ends_at, d) }))),
  );
  const groups = groupByDay(appts, range.days);
  const notice = noticeText(sp.notice);
  const useGrid = view !== "agenda";

  return (
    <>
      <PageHeader title="Calendar" description="Times are South African Standard Time (SAST)." actions={<LinkButton href="/app/calendar/new">New appointment</LinkButton>} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {apptRes.error && <Notice tone="error">We could not load the calendar. Please refresh the page.</Notice>}
      <CalendarToolbar view={view} date={date} status={status} q={q} label={rangeLabel(view, range.first, range.last)} />
      {useGrid && <TimeGrid days={range.days} appts={appts} today={today} startHour={hours.startHour} endHour={hours.endHour} />}
      {/* phones get the agenda for day and week too (the grid is hidden below md); on larger screens only the Agenda view shows it */}
      <Agenda groups={groups} today={today} keepEmpty={view === "day"} className={useGrid ? "md:hidden" : undefined} />
    </>
  );
}
