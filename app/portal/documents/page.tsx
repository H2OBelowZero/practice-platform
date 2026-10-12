import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { latestPerKey, templateTitle } from "@/lib/forms/access";
import { formPeople } from "@/lib/forms/people";
import { formNotice } from "@/lib/forms/notices";
import type { FormSchema } from "@/lib/forms/validate";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel } from "@/lib/time";
import { ActionButton } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { startForm } from "./actions";

export const metadata = { title: "Documents" };

type Row = {
  id: string; patient_id: string; status: "draft" | "submitted" | "returned"; template_version: number; submitted_at: string | null; return_note: string | null; updated_at: string;
  form_templates: { key: string; schema: FormSchema } | null; patients: { first_name: string; user_id: string | null } | null;
};

/**
 * Forms for the signed-in patient, or for the people a guardian cares for. Everything is read through the caller's own client, so RLS decides
 * what arrives (a guardian without the forms permission sees nothing for that child).
 */
export default async function PortalDocuments({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const notice = formNotice((await searchParams).notice);
  const sb = await supabaseServer();
  const today = sastDate(new Date());

  const [subs, people, templates] = await Promise.all([
    sb.from("form_submissions")
      .select("id, patient_id, status, template_version, submitted_at, return_note, updated_at, form_templates(key, schema), patients(first_name, user_id)")
      .order("updated_at", { ascending: false }).limit(200),
    formPeople(sb, me.userId, today),
    sb.from("form_templates").select("id, key, version, schema").eq("active", true),
  ]);
  const rows = (subs.data ?? []) as unknown as Row[];

  const showNames = people.length > 1 || people.some((p) => !p.own);

  const toDo = rows.filter((r) => r.status !== "submitted").sort((a, b) => Number(b.status === "returned") - Number(a.status === "returned"));
  const done = rows.filter((r) => r.status === "submitted");
  const available = latestPerKey((templates.data ?? []) as unknown as { id: string; key: string; version: number; schema: FormSchema }[]);
  const nameOf = (r: Row) => (r.patients?.user_id === me.userId ? null : r.patients?.first_name ?? null);
  const title = (r: Row) => (r.form_templates ? templateTitle(r.form_templates) : "Form");

  return (
    <>
      <PageHeader title="Documents" description="Forms and consents for you to complete, and the ones you have already sent."
                  actions={<LinkButton href="/portal/privacy" variant="secondary">Privacy and consent</LinkButton>} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {subs.error && <Notice tone="error">We could not load your forms. Please refresh the page.</Notice>}

      <section aria-labelledby="todo-h" className="mb-10">
        <h2 id="todo-h" className="mb-4">To complete</h2>
        {toDo.length === 0 ? <Notice tone="info">You have no forms to complete right now.</Notice> : (
          <ul className="grid list-none gap-4 p-0">
            {toDo.map((r) => (
              <li key={r.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg"><Link href={`/portal/documents/${r.id}`}>{title(r)}</Link></h3>
                      {nameOf(r) && <p className="text-ink-muted">For <strong className="text-ink">{nameOf(r)}</strong></p>}
                    </div>
                    <StatusChip status={r.status} label={r.status === "returned" ? "Needs changes" : "To complete"} />
                  </div>
                  {r.status === "returned" && r.return_note && (
                    <div className="mt-3 rounded-xl bg-warn-tint p-3 text-warn-ink">
                      <p className="font-medium">Message from the practice</p>
                      <p className="whitespace-pre-wrap break-words">{r.return_note}</p>
                    </div>
                  )}
                  <div className="mt-4">
                    <LinkButton href={`/portal/documents/${r.id}`} variant={r.status === "returned" ? "primary" : "secondary"} aria-label={`${r.status === "returned" ? "Update" : "Continue"} ${title(r)}${nameOf(r) ? ` for ${nameOf(r)}` : ""}`}>
                      {r.status === "returned" ? "Update and resubmit" : "Continue"}
                    </LinkButton>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="done-h" className="mb-10">
        <h2 id="done-h" className="mb-4">Completed</h2>
        {done.length === 0 ? <p className="text-ink-muted">Nothing here yet.</p> : (
          <ul className="grid list-none gap-4 p-0">
            {done.map((r) => (
              <li key={r.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg"><Link href={`/portal/documents/${r.id}`}>{title(r)}</Link></h3>
                      <p className="text-ink-muted">
                        {r.submitted_at ? `Submitted on ${sastDateLabel(r.submitted_at)}` : "Submitted"}
                        {nameOf(r) && <> · For <strong className="text-ink">{nameOf(r)}</strong></>}
                      </p>
                    </div>
                    <StatusChip status="submitted" label="Completed" />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="start-h">
        <h2 id="start-h" className="mb-4">Start a form</h2>
        {templates.error ? <Notice tone="error">We could not load the list of forms. Please refresh the page.</Notice>
          : people.length === 0 ? <Notice tone="info">There is no record on this account that forms can be started for yet. Please contact the practice.</Notice>
          : available.length === 0 ? <p className="text-ink-muted">There are no forms to start at the moment.</p>
          : people.map((p) => {
            const open = new Set(rows.filter((r) => r.patient_id === p.id && r.status !== "submitted").map((r) => r.form_templates?.key));
            const sent = new Map<string, string>();
            for (const r of rows) if (r.patient_id === p.id && r.status === "submitted" && r.form_templates && r.submitted_at && !sent.has(r.form_templates.key)) sent.set(r.form_templates.key, r.submitted_at);
            const startable = available.filter((t) => !open.has(t.key));
            return (
              <div key={p.id} className="mb-6">
                {showNames && <h3 className="mb-3 text-lg">{p.own ? "For you" : `For ${p.first_name}`}</h3>}
                {startable.length === 0 ? <p className="text-ink-muted">Every available form is already waiting for you above.</p> : (
                  <ul className="grid list-none gap-3 p-0">
                    {startable.map((t) => (
                      <li key={t.id}>
                        <Card className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="font-medium">{templateTitle(t)}</p>
                            {sent.has(t.key) && <p className="text-sm text-ink-muted">You completed this on {sastDateLabel(sent.get(t.key)!)}.</p>}
                          </div>
                          <ActionButton action={startForm} args={[p.id, t.id]} submitLabel={<>{sent.has(t.key) ? "Fill in again" : "Start"}<span className="sr-only"> {templateTitle(t)}{showNames ? ` for ${p.own ? "yourself" : p.first_name}` : ""}</span></>} pendingLabel="Opening…" variant="secondary" />
                        </Card>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
      </section>
    </>
  );
}
