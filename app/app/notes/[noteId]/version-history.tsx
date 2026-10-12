"use client";

import { useState, useTransition } from "react";
import type { NoteContent } from "@/lib/notes/content";
import type { NoteField } from "@/lib/notes/templates";
import { Button } from "@/components/ui/button";
import { loadNoteVersion } from "../actions";

export type VersionRow = { id: number; versionNo: number; when: string; who: string };

/**
 * The draft versions of a signed note: when and who only. A version's text is fetched (by the loadNoteVersion action) only when the psychologist
 * asks for it, and held in this component's state only (no URL, no storage).
 */
export function VersionHistory({ noteId, fields, versions }: { noteId: string; fields: NoteField[]; versions: VersionRow[] }) {
  const [open, setOpen] = useState<Record<number, NoteContent | "error">>({});
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);

  const toggle = (id: number) => {
    if (open[id]) { setOpen((o) => Object.fromEntries(Object.entries(o).filter(([k]) => Number(k) !== id))); return; }
    setBusyId(id);
    start(async () => {
      let r;
      try { r = await loadNoteVersion(noteId, id); } catch { r = null; }
      setOpen((o) => ({ ...o, [id]: r?.ok ? r.content : "error" }));
      setBusyId(null);
    });
  };

  return (
    <ol className="m-0 grid list-none gap-3 p-0">
      {versions.map((v) => {
        const shown = open[v.id];
        return (
          <li key={v.id} className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p><span className="font-medium">Draft version {v.versionNo}</span> <span className="text-ink-muted">· saved {v.when} by {v.who}</span></p>
              <Button type="button" variant="quiet" className="min-h-11" aria-expanded={!!shown} loading={pending && busyId === v.id} onClick={() => toggle(v.id)}>
                {shown ? "Hide this version" : "Show this version"}
              </Button>
            </div>
            <div aria-live="polite">
              {shown === "error" && <p className="mt-3 font-medium text-danger">We could not load this version. Please try again.</p>}
              {shown && shown !== "error" && (
                <dl className="mt-3 grid gap-3">
                  {fields.map((f) => (
                    <div key={f.key}>
                      <dt className="text-sm font-medium text-ink-muted">{f.label}</dt>
                      <dd className="whitespace-pre-wrap">{shown[f.key]?.trim() ? shown[f.key] : <span className="text-ink-muted">Empty</span>}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
