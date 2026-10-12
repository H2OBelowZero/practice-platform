import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { patientIdSchema } from "@/lib/notes/input";
import { templateFields } from "@/lib/notes/templates";
import { statusMeta } from "@/lib/status";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDateLabel, sastTime } from "@/lib/time";
import { ActionForm } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { createNote } from "@/app/app/notes/actions";

// The title never carries a patient's name (it shows in browser history and tabs).
export const metadata = { title: "New clinical note" };

type Appt = { id: string; starts_at: string; status: string; session_types: { name: string } | null };

/** Start a clinical note: choose a template and, optionally, one of this patient's attended or confirmed appointments. Psychologist only (everyone else gets a 404). */
export default async function NewNotePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ appointment?: string }> }) {
  await requireRole(["psychologist"]);
  const pid = patientIdSchema.safeParse((await params).id);
  if (!pid.success) notFound();
  const sb = await supabaseServer();

  const { data: patient } = await sb.from("patients").select("id, first_name, last_name").eq("id", pid.data).maybeSingle();
  if (!patient) notFound();

  const [tpls, appts] = await Promise.all([
    sb.from("note_templates").select("id, name, schema").eq("active", true).order("name"),
    sb.from("appointments").select("id, starts_at, status, session_types(name)").eq("patient_id", patient.id).in("status", ["attended", "confirmed"])
      .order("starts_at", { ascending: false }).limit(50),
  ]);
  if (tpls.error || appts.error) return <Notice tone="error">We could not load the note templates. Please refresh the page.</Notice>;
  const templates = (tpls.data ?? []) as { id: string; name: string; schema: unknown }[];
  const appointments = (appts.data ?? []) as unknown as Appt[];

  const wanted = patientIdSchema.safeParse((await searchParams).appointment); // a malformed or foreign id is simply not preselected (createNote checks it again)
  const preselected = wanted.success && appointments.some((a) => a.id === wanted.data) ? wanted.data : "";
  const soap = templates.find((t) => t.name === "SOAP") ?? templates[0];
  const back = `/app/patients/${patient.id}?tab=notes`;

  return (
    <>
      <PageHeader title="New clinical note" description={<>For {patient.first_name} {patient.last_name}. <Link href={back}>Back to the notes</Link></>} />
      {templates.length === 0 ? <Notice tone="warning">There are no active note templates, so a note cannot be started.</Notice> : (
        <Card className="max-w-2xl">
          <ActionForm action={createNote} args={[patient.id]} submitLabel="Start note" pendingLabel="Starting…">
            <Select id="template" label="Template" required defaultValue={soap.id}
                    hint="The template sets which sections the note has. You can only choose it now; it cannot be changed once the note is started.">
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({templateFields(t.schema).map((f) => f.label).join(", ")})</option>)}
            </Select>
            <Select id="appointment" label="Appointment (optional)" defaultValue={preselected}
                    hint="Link the note to a session. Only this patient's attended and confirmed appointments are listed.">
              <option value="">Not linked to an appointment</option>
              {appointments.map((a) => (
                <option key={a.id} value={a.id}>
                  {sastDateLabel(a.starts_at)}, {sastTime(a.starts_at)} · {a.session_types?.name ?? "Session"} ({statusMeta(a.status).label})
                </option>
              ))}
            </Select>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
