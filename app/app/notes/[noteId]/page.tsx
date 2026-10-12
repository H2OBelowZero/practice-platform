import Link from "next/link";
import { notFound } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { sanitiseContent, sanitiseRisk, NOTE_FIELD_MAX } from "@/lib/notes/content";
import { noteId as noteIdSchema } from "@/lib/notes/input";
import { RISK_LABEL } from "@/lib/notes/risk";
import { templateFields } from "@/lib/notes/templates";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDateLabel, sastTime } from "@/lib/time";
import { ActionForm } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { addAddendum } from "../actions";
import { NoteEditor } from "./note-editor";
import { VersionHistory } from "./version-history";

// The title never carries a patient's name or any note text (it shows in browser history and tabs).
export const metadata = { title: "Clinical note" };

type Row = {
  id: string; patient_id: string; appointment_id: string | null; state: string; content: unknown; risk: unknown;
  author_id: string; signed_at: string | null; created_at: string;
  note_templates: { name: string; schema: unknown } | null;
  patients: { id: string; first_name: string; last_name: string } | null;
  appointments: { id: string; starts_at: string; session_types: { name: string } | null } | null;
};
type Addendum = { id: string; content: string; author_id: string; created_at: string };
type Version = { id: number; version_no: number; saved_by: string | null; saved_at: string };

const NOTICES: Record<string, string> = {
  signed: "The note is signed. It is now read-only; corrections are made with an addendum.",
  addendum: "The addendum was added to the note.",
};
const when = (iso: string) => `${sastDateLabel(iso)} at ${sastTime(iso)} (SAST)`;

/**
 * One clinical note. Psychologist only (every other role gets a 404). Read through the signed-in user's own client, so RLS decides what exists.
 * Every load is audited (note.view) before anything is shown, fail-closed like patient.view: if the audit write fails the page fails, because
 * a clinical note must not be read unrecorded. A draft opens in the editor; a signed or amended note is read-only with its history and addenda.
 */
export default async function NotePage({ params, searchParams }: { params: Promise<{ noteId: string }>; searchParams: Promise<{ notice?: string }> }) {
  await requireRole(["psychologist"]);
  const id = noteIdSchema.safeParse((await params).noteId);
  if (!id.success) notFound();
  const sp = await searchParams;

  const sb = await supabaseServer();
  const { data } = await sb.from("clinical_notes")
    .select("id, patient_id, appointment_id, state, content, risk, author_id, signed_at, created_at, note_templates(name, schema), patients(id, first_name, last_name), appointments(id, starts_at, session_types(name))")
    .eq("id", id.data).maybeSingle();
  const note = data as unknown as Row | null;
  if (!note) notFound();
  await audit("note.view", "clinical_notes", note.id);

  const fields = templateFields(note.note_templates?.schema);
  const content = sanitiseContent(fields.map((f) => f.key), note.content);
  const risk = sanitiseRisk(note.risk);
  const draft = note.state === "draft";
  const notice = sp.notice && Object.hasOwn(NOTICES, sp.notice) ? NOTICES[sp.notice] : undefined;

  const [adds, vers] = draft ? [null, null] : await Promise.all([
    sb.from("note_addenda").select("id, content, author_id, created_at").eq("note_id", note.id).order("created_at"),
    sb.from("note_versions").select("id, version_no, saved_by, saved_at").eq("note_id", note.id).order("version_no", { ascending: false }).limit(100),
  ]);
  const addenda = (adds?.data ?? []) as Addendum[];
  const versions = (vers?.data ?? []) as Version[];

  const people = [...new Set([note.author_id, ...addenda.map((a) => a.author_id), ...versions.map((v) => v.saved_by).filter((x): x is string => !!x)])];
  const { data: profs } = await sb.from("profiles").select("user_id, display_name").in("user_id", people);
  const nameOf = new Map((profs ?? []).map((p) => [p.user_id as string, (p.display_name as string) || "Unnamed user"]));
  const who = (uid: string | null) => (uid ? nameOf.get(uid) ?? "Another user" : "System");

  const patient = note.patients;
  const back = `/app/patients/${note.patient_id}?tab=notes`;
  const appt = note.appointments;

  return (
    <>
      <PageHeader title="Clinical note"
                  description={<>{patient ? <>For <Link href={`/app/patients/${patient.id}`}>{patient.first_name} {patient.last_name}</Link>. </> : null}<Link href={back}>Back to the notes</Link></>} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {(adds?.error || vers?.error) && <Notice tone="error">We could not load the history of this note. Please refresh the page.</Notice>}

      <Card className="mb-8">
        <div className="mb-5"><StatusChip status={note.state} /></div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-muted">Template</dt><dd className="font-medium">{note.note_templates?.name ?? "Note"}</dd>
          <dt className="text-ink-muted">Author</dt><dd className="font-medium">{who(note.author_id)}</dd>
          <dt className="text-ink-muted">Started</dt><dd className="font-medium">{when(note.created_at)}</dd>
          {note.signed_at && <><dt className="text-ink-muted">Signed</dt><dd className="font-medium">{when(note.signed_at)}</dd></>}
          <dt className="text-ink-muted">Appointment</dt>
          <dd className="font-medium">
            {appt ? <Link href={`/app/calendar/${appt.id}`}>{sastDateLabel(appt.starts_at)}, {sastTime(appt.starts_at)} · {appt.session_types?.name ?? "Session"}</Link> : "Not linked to an appointment"}
          </dd>
        </dl>
      </Card>

      {draft ? (
        <NoteEditor noteId={note.id} fields={fields} initialContent={content} initialRisk={risk} />
      ) : (
        <>
          <section aria-labelledby="content-h" className="mb-8">
            <h2 id="content-h" className="mb-4">Note</h2>
            <Card>
              <dl className="grid gap-5">
                {fields.map((f) => (
                  <div key={f.key}>
                    <dt className="font-medium">{f.label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap">{content[f.key]?.trim() ? content[f.key] : <span className="text-ink-muted">Nothing written</span>}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </section>

          <section aria-labelledby="risk-h" className="mb-8">
            <h2 id="risk-h" className="mb-4">Risk</h2>
            <Card>
              <p className="font-medium">Risk level: {RISK_LABEL[risk.level]}</p>
              {risk.notes.trim() && <p className="mt-2 whitespace-pre-wrap">{risk.notes}</p>}
              <p className="mt-3 text-sm text-ink-muted">Risk flags prompt your professional assessment; they do not diagnose.</p>
            </Card>
          </section>

          <section aria-labelledby="addenda-h" className="mb-8">
            <h2 id="addenda-h" className="mb-4">Addenda</h2>
            {addenda.length === 0 ? <p className="mb-4 text-ink-muted">No addenda. The note has not been corrected since it was signed.</p> : (
              <ol className="m-0 mb-6 grid list-none gap-3 p-0">
                {addenda.map((a) => (
                  <li key={a.id} className="rounded-xl border border-line bg-surface p-4">
                    <p className="whitespace-pre-wrap">{a.content}</p>
                    <p className="mt-2 text-sm text-ink-muted">{who(a.author_id)} · {when(a.created_at)}</p>
                  </li>
                ))}
              </ol>
            )}
            <Card className="max-w-2xl">
              <h3 className="mb-2 text-lg">Add an addendum</h3>
              <p className="mb-4 text-ink-muted">A signed note cannot be changed. An addendum is added below it with your name and the time, and the note shows as amended.</p>
              <ActionForm action={addAddendum} args={[note.id]} submitLabel="Add addendum" pendingLabel="Adding…">
                <Textarea id="content" label="Addendum" required rows={5} maxLength={NOTE_FIELD_MAX} />
              </ActionForm>
            </Card>
          </section>

          <section aria-labelledby="versions-h">
            <h2 id="versions-h" className="mb-2">Version history</h2>
            <p className="mb-4 max-w-2xl text-ink-muted">Earlier drafts of this note, kept each time the text changed before signing. The text is shown only when you open a version.</p>
            {versions.length === 0 ? <p className="text-ink-muted">No earlier drafts were kept.</p> : (
              <VersionHistory noteId={note.id} fields={fields}
                              versions={versions.map((v) => ({ id: v.id, versionNo: v.version_no, when: when(v.saved_at), who: who(v.saved_by) }))} />
            )}
          </section>
        </>
      )}
    </>
  );
}

