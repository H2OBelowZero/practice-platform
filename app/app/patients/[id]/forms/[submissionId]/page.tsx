import Link from "next/link";
import { notFound } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { templateTitle } from "@/lib/forms/access";
import { patientIdSchema, submissionId } from "@/lib/forms/input";
import { loadSubmission } from "@/lib/forms/load";
import { AnswersView } from "@/lib/forms/render";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDateLabel, sastTime } from "@/lib/time";
import { ActionForm, FocusOnMount } from "@/components/ui/action-form";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { returnForm } from "../actions";

export const metadata = { title: "Form" };

type Snapshot = { id: number; at: string; answers: Record<string, unknown>; template_version: number; actor: string | null };

/**
 * A patient's form, read-only, for staff. Opening it is audited (form.view) BEFORE anything is shown, and fails closed like the record page.
 * Visibility is RLS: an admin gets a 404 for a restricted (health history) form, and a submission that belongs to a different patient is a 404 too.
 * Shows the current answers by field label, the snapshot taken at every submission (a returned and resubmitted form has more than one), and the
 * "Return for correction" action with its inline confirmation panel.
 */
export default async function StaffFormView({ params, searchParams }: { params: Promise<{ id: string; submissionId: string }>; searchParams: Promise<{ confirm?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const p = await params;
  const pid = patientIdSchema.safeParse(p.id), sid = submissionId.safeParse(p.submissionId);
  if (!pid.success || !sid.success) notFound();
  const confirming = (await searchParams).confirm === "return";

  const sb = await supabaseServer();
  const sub = await loadSubmission(sb, sid.data);
  if (!sub || sub.patient_id !== pid.data) notFound();
  const { data: patient } = await sb.from("patients").select("first_name, last_name").eq("id", pid.data).maybeSingle();
  if (!patient) notFound();
  await audit("form.view", "form_submissions", sub.id, { patient_id: pid.data, template_key: sub.key, template_version: sub.template_version });

  const { data: snaps } = await sb.from("form_submission_versions").select("id, at, answers, template_version, actor").eq("submission_id", sub.id).order("id", { ascending: false });
  const snapshots = (snaps ?? []) as Snapshot[];
  const actors = [...new Set([sub.submitted_by, ...snapshots.map((s) => s.actor)].filter((x): x is string => !!x))];
  const { data: profs } = actors.length ? await sb.from("profiles").select("user_id, role, display_name").in("user_id", actors) : { data: [] };
  const who = new Map((profs ?? []).map((x) => [x.user_id as string, x.role === "patient" ? "Patient" : x.role === "guardian" ? "Guardian" : `Staff: ${(x.display_name as string) || "unnamed"}`]));

  const title = templateTitle({ key: sub.key, schema: sub.schema });
  const base = `/app/patients/${pid.data}`;
  const here = `${base}/forms/${sub.id}`;

  return (
    <>
      <p className="mb-2 text-sm"><Link href={`${base}?tab=forms`}>Back to {patient.first_name as string} {patient.last_name as string}</Link></p>
      <PageHeader title={title} description={`${patient.first_name as string} ${patient.last_name as string} · version ${sub.template_version}`}
                  actions={<StatusChip status={sub.status} label={sub.status === "draft" ? "Waiting for patient" : undefined} />} />

      <div className="grid gap-6">
        <Card>
          <p className="mb-6 text-ink-muted">
            {sub.submitted_at
              ? `Submitted on ${sastDateLabel(sub.submitted_at)} at ${sastTime(sub.submitted_at)} (South African time)${sub.submitted_by ? ` by ${who.get(sub.submitted_by) ?? "another user"}` : ""}.`
              : "Not submitted yet. These are the answers saved so far."}
          </p>
          {sub.status === "returned" && sub.return_note && (
            <div className="mb-6 rounded-xl bg-warn-tint p-3 text-warn-ink">
              <p className="font-medium">Returned to the patient with this note</p>
              <p className="whitespace-pre-wrap break-words">{sub.return_note}</p>
            </div>
          )}
          <AnswersView schema={sub.schema} answers={sub.answers} />
        </Card>

        {sub.status === "submitted" && (
          <Card className="max-w-2xl">
            <h2 className="mb-2 text-lg">Return for correction</h2>
            <p className="mb-4 text-ink-muted">Sends the form back to the patient with a note about what to change. Their earlier answers stay on record.</p>
            {!confirming ? (
              <LinkButton href={`${here}?confirm=return#return-panel`} variant="secondary">Return for correction…</LinkButton>
            ) : (
              <FocusOnMount id="return-panel" className="rounded-xl border-2 border-line-strong bg-sunk p-4">
                <h3 className="mb-2 font-semibold">Return this form to the patient?</h3>
                <ActionForm action={returnForm} args={[pid.data, sub.id]} submitLabel="Return form" pendingLabel="Returning…">
                  <Textarea id="note" label="What needs to change?" hint="The patient reads this note. Do not include other people's information. 1 to 1000 characters." required maxLength={1000} rows={4} />
                </ActionForm>
                <p className="mt-4"><LinkButton href={here} variant="quiet">No, keep it as submitted</LinkButton></p>
              </FocusOnMount>
            )}
          </Card>
        )}

        <section aria-labelledby="hist-h" className="max-w-3xl">
          <h2 id="hist-h" className="mb-2 text-lg">Submission history</h2>
          {snapshots.length === 0 ? <p className="text-ink-muted">Nothing has been submitted yet.</p> : (
            <>
              <p className="mb-3 text-ink-muted">A copy of the answers is kept every time the form is submitted, so a correction never overwrites what was sent before.</p>
              <ol className="grid list-none gap-3 p-0">
                {snapshots.map((s, i) => (
                  <li key={s.id}>
                    <details className="rounded-xl border border-line bg-surface p-4">
                      <summary className="cursor-pointer font-medium">
                        {sastDateLabel(s.at)} at {sastTime(s.at)} · version {s.template_version} · {s.actor ? who.get(s.actor) ?? "another user" : "System"}
                        {i === 0 && " (latest)"}
                      </summary>
                      <div className="mt-4"><AnswersView schema={sub.schema} answers={s.answers} /></div>
                    </details>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>
    </>
  );
}
