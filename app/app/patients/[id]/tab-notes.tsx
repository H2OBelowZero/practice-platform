import Link from "next/link";
import { sastDateLabel, sastTime } from "@/lib/time";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { StatusChip } from "@/components/ui/status-chip";
import type { TabContext } from "./tabs";

type Row = {
  id: string; state: string; created_at: string; signed_at: string | null; author_id: string;
  note_templates: { name: string } | null;
  appointments: { starts_at: string; session_types: { name: string } | null } | null;
};

/**
 * The patient's clinical notes, newest first: date, linked appointment, template, state and author. Only metadata is read here, never the text.
 * Psychologist only (the tab is hidden for everyone else, and RLS returns no notes to any other role). Opening a note is audited on the note page.
 */
export async function NotesTab({ patient, sb }: TabContext) {
  const { data, error } = await sb.from("clinical_notes")
    .select("id, state, created_at, signed_at, author_id, note_templates(name), appointments(starts_at, session_types(name))")
    .eq("patient_id", patient.id).order("created_at", { ascending: false }).limit(200);
  if (error) return <Notice tone="error">We could not load the notes for this patient. Please refresh the page.</Notice>;
  const rows = (data ?? []) as unknown as Row[];

  const authors = [...new Set(rows.map((r) => r.author_id))];
  const { data: profs } = authors.length ? await sb.from("profiles").select("user_id, display_name").in("user_id", authors) : { data: [] };
  const who = new Map((profs ?? []).map((p) => [p.user_id as string, (p.display_name as string) || "Unnamed user"]));

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-ink-muted">Session notes are private to the psychologist. A signed note cannot be changed; corrections are added as addenda.</p>
        <LinkButton href={`/app/patients/${patient.id}/notes/new`}>New note</LinkButton>
      </div>

      {rows.length === 0 ? <Notice tone="info">No notes have been written for this patient yet.</Notice> : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Clinical notes for this patient, newest first</caption>
            <thead className="bg-sunk text-sm text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Started</th>
                <th scope="col" className="px-4 py-3 font-medium">Appointment</th>
                <th scope="col" className="px-4 py-3 font-medium">Template</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Author</th>
                <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const day = sastDateLabel(r.created_at);
                return (
                  <tr key={r.id} className="border-t border-line align-top">
                    <td className="px-4 py-3 whitespace-nowrap">{day}, {sastTime(r.created_at)}</td>
                    <td className="px-4 py-3">
                      {r.appointments ? `${sastDateLabel(r.appointments.starts_at)}, ${r.appointments.session_types?.name ?? "Session"}` : <span className="text-ink-muted">Not linked</span>}
                    </td>
                    <td className="px-4 py-3">{r.note_templates?.name ?? "Note"}</td>
                    <td className="px-4 py-3"><StatusChip status={r.state} />{r.signed_at && <span className="mt-1 block text-sm text-ink-muted">{sastDateLabel(r.signed_at)}</span>}</td>
                    <td className="px-4 py-3">{who.get(r.author_id) ?? "Another user"}</td>
                    <td className="px-4 py-3">
                      <Link href={`/app/notes/${r.id}`} aria-label={`${r.state === "draft" ? "Continue" : "Open"} the ${r.note_templates?.name ?? ""} note started ${day}`}>
                        {r.state === "draft" ? "Continue" : "Open"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
