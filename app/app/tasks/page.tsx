import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { formatZar } from "@/lib/money";
import { hrefWith, pageCount, pageRange, parsePage } from "@/lib/patients/list";
import { groupFilter, groupLabel, isPayfastUnreconciled, parseTaskGroup, payfastDetails, taskExplanation, taskGroup, TASK_GROUP_FILTERS } from "@/lib/tasks/groups";
import { taskLink } from "@/lib/tasks/links";
import { dueBounds, DUE_FILTERS, parseTaskDue, parseTaskPriority, parseTaskStatus, PRIORITY_FILTERS, taskNotice } from "@/lib/tasks/list";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { DueText, PriorityChip } from "@/components/tasks/chips";
import { ActionButton, ActionForm } from "@/components/ui/action-form";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Pager } from "@/components/ui/pager";
import { StatusChip } from "@/components/ui/status-chip";
import { setTaskStatus, updateTask } from "./actions";

export const metadata = { title: "Tasks" };

type Row = {
  id: string; title: string; due_at: string | null; priority: string; status: string; source: string | null;
  patient_id: string | null; appointment_id: string | null; meta: unknown; created_at: string;
};

/**
 * Staff tasks (psychologist and admin; everyone else gets a 404). Everything is read through the signed-in user's own client: the admin never sees a
 * risk_flag task (RLS, 0013) and the "Clinical risk" filter is only offered to the psychologist. A risk task shows its plain title only, never any note content.
 * Open tasks come first by due date (undated last); done tasks newest first.
 */
export default async function TasksPage({ searchParams }: { searchParams: Promise<{ status?: string; priority?: string; due?: string; group?: string; page?: string; notice?: string }> }) {
  const me = await requireRole(["psychologist", "admin"]);
  const sp = await searchParams;
  const status = parseTaskStatus(sp.status);
  const priority = parseTaskPriority(sp.priority);
  const due = parseTaskDue(sp.due);
  const group = parseTaskGroup(sp.group);
  const page = parsePage(sp.page);
  const notice = taskNotice(sp.notice);
  const today = sastDate(new Date());
  const { from, to } = pageRange(page);
  const params = { status: status === "done" ? "done" : undefined, priority, due, group };
  const here = (p: number) => hrefWith("/app/tasks", { ...params, page: p > 1 ? p : undefined });
  const back = here(page);
  const groups = TASK_GROUP_FILTERS.filter((g) => g.value !== "clinical" || me.role === "psychologist");

  const sb = await supabaseServer();
  let query = sb.from("tasks").select("id, title, due_at, priority, status, source, patient_id, appointment_id, meta, created_at", { count: "exact" }).eq("status", status);
  if (priority) query = query.eq("priority", priority);
  if (due) {
    const b = dueBounds(due, today);
    if (b.isNull) query = query.is("due_at", null);
    if (b.gte) query = query.gte("due_at", b.gte);
    if (b.lt) query = query.lt("due_at", b.lt);
  }
  const gf = groupFilter(group);
  if (gf) query = query.or(gf);
  query = status === "open"
    ? query.order("due_at", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false })
    : query.order("created_at", { ascending: false });
  const res = await query.order("id").range(from, to);
  if (res.error?.code === "PGRST103" && page > 1) redirect(here(1)); // a page past the end (hand-typed URL)

  const rows = (res.data ?? []) as Row[];
  const total = res.count ?? rows.length;
  const patientIds = [...new Set(rows.map((r) => r.patient_id).filter((x): x is string => !!x))];
  const nameOf = new Map<string, string>();
  if (patientIds.length) {
    const { data } = await sb.from("patients").select("id, first_name, last_name").in("id", patientIds);
    for (const p of data ?? []) nameOf.set(p.id as string, `${p.first_name} ${p.last_name}`);
  }
  const filtered = status === "done" || priority !== "" || due !== "" || group !== "";

  return (
    <>
      <PageHeader title="Tasks" description="Things that need a person: follow-ups the system raised and reminders you add yourself." actions={<LinkButton href="/app/tasks/new">New task</LinkButton>} />
      {notice && <Notice tone="success">{notice}</Notice>}

      <form method="get" action="/app/tasks" role="search" aria-label="Filter tasks" className="mb-6 flex flex-wrap items-end gap-3">
        <div className="min-w-36 flex-1 [&>div]:mb-0">
          <Select id="status" label="Show" defaultValue={status}><option value="open">Open tasks</option><option value="done">Done tasks</option></Select>
        </div>
        <div className="min-w-40 flex-1 [&>div]:mb-0">
          <Select id="priority" label="Priority" defaultValue={priority}>{PRIORITY_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
        </div>
        <div className="min-w-44 flex-1 [&>div]:mb-0">
          <Select id="due" label="Due" defaultValue={due}>{DUE_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
        </div>
        <div className="min-w-44 flex-1 [&>div]:mb-0">
          <Select id="group" label="Kind" defaultValue={group}>{groups.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>
        </div>
        <Button type="submit" variant="secondary">Apply</Button>
        {filtered && <LinkButton variant="quiet" href="/app/tasks">Clear</LinkButton>}
      </form>

      {res.error && <Notice tone="error">We could not load the tasks. Please refresh the page.</Notice>}
      {!res.error && rows.length === 0 && <Notice tone="info">{filtered ? "No tasks match. Try different filters." : "There are no open tasks. Nothing is waiting on you."}</Notice>}

      {rows.length > 0 && (
        <>
          <ul aria-label={status === "open" ? "Open tasks" : "Done tasks"} className="m-0 grid list-none gap-3 p-0">
            {rows.map((t) => {
              const link = taskLink(t);
              const who = t.patient_id ? nameOf.get(t.patient_id) : undefined;
              const pf = isPayfastUnreconciled(t.source) ? payfastDetails(t.meta) : null;
              const why = taskExplanation(t.source);
              return (
                <li key={t.id} className="rounded-card border border-line bg-surface p-4 shadow-card">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="max-w-xl font-medium">{t.title}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {t.status === "done" ? <StatusChip status="done" /> : <PriorityChip priority={t.priority} />}
                    </div>
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">
                    {groupLabel(taskGroup(t.source))}
                    {who && t.patient_id && <> · <Link href={`/app/patients/${t.patient_id}`}>{who}</Link></>}
                  </p>
                  {t.status === "open" && <p className="mt-1 text-sm"><DueText task={t} today={today} /></p>}
                  {pf && (
                    <div className="mt-3 rounded-xl bg-warn-tint p-3 text-warn-ink">
                      <p className="font-semibold">Payment received at PayFast that could not be matched</p>
                      <p>PayFast took {formatZar(pf.amountCents)}. The invoice had {formatZar(pf.outstandingCents)} outstanding. {pf.reason}</p>
                      <p>Refund it in the PayFast dashboard or record an adjustment, then mark this done.</p>
                    </div>
                  )}
                  {!pf && why && <p className="mt-2 max-w-2xl text-sm text-ink-muted">{why}</p>}

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {link && <LinkButton variant="secondary" href={link.href}>{link.label}</LinkButton>}
                    {t.status === "open"
                      ? <ActionButton action={setTaskStatus} args={[t.id, "done", back]} submitLabel={<>Mark done<span className="sr-only">: {t.title}</span></>} pendingLabel="Saving…" variant="secondary" />
                      : <ActionButton action={setTaskStatus} args={[t.id, "open", back]} submitLabel={<>Reopen<span className="sr-only">: {t.title}</span></>} pendingLabel="Saving…" variant="secondary" />}
                  </div>

                  <details className="mt-3">
                    <summary className="inline-flex min-h-11 cursor-pointer items-center text-blue-700 underline underline-offset-4">Change due date or priority<span className="sr-only">: {t.title}</span></summary>
                    <ActionForm action={updateTask} args={[t.id, back]} submitLabel="Save changes" pendingLabel="Saving…" className="mt-3 flex flex-wrap items-end gap-3">
                      <div className="min-w-44 flex-1 [&>div]:mb-0">
                        <Input id={`due-${t.id}`} name="due" label="Due date" type="date" defaultValue={t.due_at ? sastDate(t.due_at) : ""} hint="Leave empty for no due date." />
                      </div>
                      <div className="min-w-40 flex-1 [&>div]:mb-0">
                        <Select id={`priority-${t.id}`} name="priority" label="Priority" defaultValue={t.priority}>
                          <option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
                        </Select>
                      </div>
                    </ActionForm>
                  </details>
                </li>
              );
            })}
          </ul>
          <Pager page={page} pages={pageCount(total)} total={total} from={from} to={to} hrefFor={here} label="Task list pages" />
        </>
      )}
    </>
  );
}
