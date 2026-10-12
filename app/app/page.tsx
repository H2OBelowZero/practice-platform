import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { formatZar } from "@/lib/money";
import { getPractice } from "@/lib/practice";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel } from "@/lib/time";
import { loadDashboard } from "@/lib/dashboard/load";
import { countText, greeting, monthLabel, statusMixText, tileCount } from "@/lib/dashboard/shape";
import { AwaitingTile, Tile } from "@/components/dashboard/tiles";
import { EnquiriesSection, PaymentsSection, RequestsSection, ScheduleSection, ShortcutsSection, TasksSection, UpcomingSection } from "@/components/dashboard/sections";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";

export const metadata = { title: "Dashboard" };

/**
 * The staff dashboard. Psychologist and admin see the same operational tiles (the admin gets no notes tile and nothing clinical); the bookkeeper is
 * sent to Billing and everyone else gets a 404 (requireRole). Every number is read through the signed-in user's own RLS client, in parallel, with
 * counts and SQL aggregates (lib/dashboard/load.ts); a failed query shows a quiet note in its own tile or section and the rest of the page still works.
 */
export default async function StaffHome() {
  const me = await requireRole(["psychologist", "admin", "bookkeeper"]);
  if (me.role === "bookkeeper") redirect("/app/billing");

  const now = new Date();
  const today = sastDate(now);
  const sb = await supabaseServer();
  const [practice, d] = await Promise.all([getPractice().catch(() => null), loadDashboard(sb, me.role, now, today)]);

  // ---- tiles ----
  const sessions = d.today.ok ? d.today.data : null;
  const requests = d.requests.ok ? d.requests.data.total : null;
  const forms = d.forms.ok ? d.forms.data.total : null;
  const dueTasks = d.tasks.ok ? d.tasks.data.dueOrOverdue : null;
  const awaitingParts = [requests, forms, dueTasks];
  const awaitingKnown = awaitingParts.filter((n): n is number => n !== null);
  const pf = d.tasks.ok ? d.tasks.data.unreconciled : null;
  const showNotes = me.role === "psychologist";
  const notes = d.notes.ok ? d.notes.data : null;
  const firstNote = notes?.first ?? null;

  return (
    <>
      <PageHeader title={greeting(now)} description={`${practice?.name ? `${practice.name} · ` : ""}${sastDateLabel(today)}`} />

      {pf !== null && pf > 0 && (
        <Notice tone="warning" title="Money to reconcile">
          <p>{countText(pf, "PayFast payment", "PayFast payments")} {pf === 1 ? "was" : "were"} received but could not be matched to an invoice. <Link href="/app/tasks?group=payfast">Look at them now</Link>.</p>
        </Notice>
      )}

      <section aria-labelledby="tiles-h" className="mb-8">
        <h2 id="tiles-h" className="sr-only">At a glance</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Tile label="Today's sessions" href="/app/calendar?view=day" unavailable={!sessions} value={tileCount(sessions?.length)}
            note={sessions ? (sessions.length === 0 ? "No sessions today" : statusMixText(sessions)) : undefined} />
          <AwaitingTile hint={me.role === "admin" ? "Some forms are only visible to the practitioner." : undefined} value={awaitingKnown.length ? String(awaitingKnown.reduce((a, n) => a + n, 0)) : tileCount(null)} partial={awaitingKnown.length < awaitingParts.length}
            rows={[
              { label: "Booking requests", count: requests, href: "/app/calendar?view=agenda&status=tentative" },
              { label: "Forms submitted this week", count: forms, href: d.forms.ok && d.forms.data.newestPatientId ? `/app/patients/${d.forms.data.newestPatientId}?tab=forms` : "/app/patients" },
              { label: "Tasks due today or overdue", count: dueTasks, href: "/app/tasks?due=now" },
            ]} />
          <Tile label="Outstanding invoices" href="/app/billing" unavailable={!d.invoices.ok} value={d.invoices.ok ? formatZar(d.invoices.data.openCents) : "–"}
            note={d.invoices.ok ? (d.invoices.data.openN === 0 ? "Nothing is owed" : `${countText(d.invoices.data.openN, "open invoice", "open invoices")}; ${d.invoices.data.overdueN === 0 ? "none overdue" : `${d.invoices.data.overdueN} overdue (${formatZar(d.invoices.data.overdueCents)})`}`) : undefined}
            attention={d.invoices.ok && d.invoices.data.overdueN > 0} />
          {showNotes && (
            <Tile label="Notes to complete" unavailable={!notes} value={tileCount(notes?.count)}
              href={firstNote ? `/app/patients/${firstNote.patient_id}/notes/new?appointment=${firstNote.id}` : "/app/patients"}
              note={notes ? (notes.count === 0 ? "All sessions have a signed note" : "Sessions with no signed note. Opens the oldest.") : undefined} />
          )}
          <Tile label="Unreconciled PayFast payments" href="/app/tasks?group=payfast" unavailable={pf === null} value={tileCount(pf)}
            note={pf === null ? undefined : pf === 0 ? "None waiting" : "Money received that needs matching"} attention={!!pf && pf > 0} />
          <Tile label="Claims needing attention" href="/app/claims" unavailable={!d.claims.ok} value={d.claims.ok ? String(d.claims.data.rejected + d.claims.data.stale) : "–"}
            note={d.claims.ok ? `${d.claims.data.rejected} rejected, ${d.claims.data.stale} waiting over 30 days` : undefined}
            attention={d.claims.ok && d.claims.data.rejected + d.claims.data.stale > 0} />
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="lg:col-span-2"><ScheduleSection s={d.today} /></div>
        <RequestsSection s={d.requests} />
        <EnquiriesSection s={d.enquiries} />
        <div className="lg:col-span-2"><UpcomingSection s={d.upcoming} /></div>
        <TasksSection s={d.tasks} today={today} />
        <PaymentsSection s={d.payments} monthLabel={monthLabel(today)} />
        <div className="lg:col-span-2"><ShortcutsSection /></div>
      </div>
    </>
  );
}
