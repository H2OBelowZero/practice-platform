import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { templateTitle } from "@/lib/forms/access";
import { submissionId } from "@/lib/forms/input";
import { loadSubmission } from "@/lib/forms/load";
import { AnswersView } from "@/lib/forms/render";
import { draftAnswers } from "@/lib/forms/draft";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDateLabel, sastTime } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { FormEditor } from "./form-editor";

export const metadata = { title: "Form" };

/**
 * One form. Open forms (draft or returned) are edited here, with the answers loaded from the database so a half-finished form resumes.
 * A submitted form is shown read-only with when it was submitted and which version of the wording it was. Visibility is RLS: someone
 * else's submission (or a guardian without the forms permission) is a 404.
 */
export default async function PortalForm({ params }: { params: Promise<{ submissionId: string }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const id = submissionId.safeParse((await params).submissionId);
  if (!id.success) notFound();

  const sb = await supabaseServer();
  const sub = await loadSubmission(sb, id.data);
  if (!sub) notFound();

  const { data: person } = await sb.from("patients").select("first_name, user_id").eq("id", sub.patient_id).maybeSingle();
  const forChild = person && person.user_id !== me.userId ? (person.first_name as string) : null;
  const title = templateTitle({ key: sub.key, schema: sub.schema });
  const submitted = sub.status === "submitted";

  return (
    <>
      <p className="mb-2 text-sm"><Link href="/portal/documents">Back to documents</Link></p>
      <PageHeader title={title} description={forChild ? `For ${forChild}` : undefined}
                  actions={<StatusChip status={sub.status} label={submitted ? "Completed" : sub.status === "returned" ? "Needs changes" : "To complete"} />} />

      {sub.status === "returned" && (
        <Notice tone="warning" title="The practice asked for changes">
          <p className="whitespace-pre-wrap break-words">{sub.return_note ?? "Please check your answers and submit the form again."}</p>
        </Notice>
      )}

      {submitted ? (
        <Card>
          <p className="mb-6 text-ink-muted">
            Submitted{sub.submitted_at ? ` on ${sastDateLabel(sub.submitted_at)} at ${sastTime(sub.submitted_at)} (South African time)` : ""}.
            {" "}This is version {sub.template_version} of the form. To change something, please contact the practice.
          </p>
          <AnswersView schema={sub.schema} answers={sub.answers} />
        </Card>
      ) : (
        <FormEditor submissionId={sub.id} schema={sub.schema} initial={draftAnswers(sub.schema, sub.answers)} updatedAt={sub.updated_at} />
      )}
    </>
  );
}
