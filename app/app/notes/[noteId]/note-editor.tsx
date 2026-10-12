"use client";

import { useCallback, useEffect, useReducer, useRef, useState, useTransition } from "react";
import { autosaveReducer, hasUnsaved, initialAutosave } from "@/lib/forms/autosave";
import { NOTE_AUTOSAVE_MS, NOTE_FIELD_MAX, type NoteContent, type NoteRisk } from "@/lib/notes/content";
import { noteSaveText } from "@/lib/notes/errors";
import { RISK_LABEL, RISK_LEVELS, type RiskLevel } from "@/lib/notes/risk";
import type { NoteField } from "@/lib/notes/templates";
import { sastTime } from "@/lib/time";
import { FocusOnMount } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { saveNoteDraft, signNote } from "../actions";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The editor for a draft note. The text lives in state; every change restarts a 3 s timer and then saves through saveNoteDraft. Nothing is lost on a
 * failed save: the text stays on screen, the status line says so and Retry saves again. If the note stopped being a draft elsewhere the editor
 * stops saving and asks for a reload. "Sign" opens an inline confirmation (no confirm() dialog): confirming first saves anything pending, then signs.
 * While something is unsaved the browser warns before the tab is closed, and a save is attempted when the tab is hidden.
 * Note text only ever travels to the server action; it is never logged, put in a URL or kept anywhere else.
 */
export function NoteEditor({ noteId, fields, initialContent, initialRisk }: { noteId: string; fields: NoteField[]; initialContent: NoteContent; initialRisk: NoteRisk }) {
  const [content, setContent] = useState(initialContent);
  const [risk, setRisk] = useState(initialRisk);
  const [formError, setFormError] = useState<string | null>(null);
  const [taskWarning, setTaskWarning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, dispatch] = useReducer(autosaveReducer, initialAutosave);
  const [signing, startSign] = useTransition();

  const latest = useRef({ content: initialContent, risk: initialRisk });
  const stored = useRef(JSON.stringify(latest.current)); // exactly what the server last confirmed
  const busy = useRef(false); // a sign is under way: no more autosaves
  const inFlight = useRef(false); // one save at a time
  const phase = useRef(state.phase);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { phase.current = state.phase; }, [state.phase]);

  /** Save what is on screen now. Resolves true when the server holds it. */
  const save = useCallback(async (): Promise<boolean> => {
    if (busy.current || inFlight.current || phase.current === "conflict") return false;
    inFlight.current = true;
    const sent = latest.current;
    dispatch({ type: "save_start" });
    try {
      const r = await saveNoteDraft(noteId, sent.content, sent.risk);
      if (r.ok) {
        stored.current = JSON.stringify(sent);
        setTaskWarning(!!r.taskFailed);
        dispatch({ type: "save_ok", at: r.at });
        return true;
      }
      if (r.closed) { dispatch({ type: "save_conflict" }); setFormError(r.error); }
      else dispatch({ type: "save_fail" });
    } catch {
      dispatch({ type: "save_fail" });
    } finally { inFlight.current = false; }
    return false;
  }, [noteId]);

  /** Make sure the server holds the text on screen (waits for a save under way, then saves again if the text moved on). */
  const flush = useCallback(async (): Promise<boolean> => {
    for (let i = 0; i < 100 && inFlight.current; i++) await wait(100);
    return JSON.stringify(latest.current) === stored.current || (await save());
  }, [save]);

  const touch = (next: { content: NoteContent; risk: NoteRisk }) => {
    latest.current = next;
    setContent(next.content);
    setRisk(next.risk);
    dispatch({ type: "change" });
  };

  // the 3 s debounce: restarts on every change (rev), runs once the typing pauses
  useEffect(() => {
    if (state.phase !== "dirty") return;
    const t = setTimeout(() => { if (!busy.current) void save(); }, NOTE_AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [state.phase, state.rev, save]);

  const unsaved = hasUnsaved(state);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const hidden = () => { if (document.visibilityState === "hidden") void save(); };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("visibilitychange", hidden); };
  }, [unsaved, save]);

  useEffect(() => { if (formError) errorRef.current?.focus(); }, [formError]);

  const confirmSign = () => {
    setFormError(null);
    startSign(async () => {
      if (!(await flush())) { setFormError("The note could not be saved, so it was not signed. Your text is still on screen; please try again."); return; }
      busy.current = true; // no autosave may land after the sign
      let message: string | undefined;
      try { message = (await signNote(noteId))?.error; } // success redirects: nothing comes back
      catch { message = "We could not reach the server. The note was not signed; please try again."; }
      busy.current = false;
      if (message) setFormError(message);
    });
  };

  return (
    <div>
      {formError && <Notice ref={errorRef} tone="error" focusable><p>{formError}</p></Notice>}
      {taskWarning && <Notice tone="warning"><p>The follow-up task for the risk flag could not be created. It will be tried again on the next save; if this stays, add a task yourself.</p></Notice>}

      <form onSubmit={(e) => e.preventDefault()} noValidate>
        {fields.map((f) => (
          <Textarea key={f.key} id={`note-${f.key}`} label={f.label} hint={f.help || undefined} placeholder={f.placeholder || undefined} rows={7} maxLength={NOTE_FIELD_MAX}
                    value={content[f.key] ?? ""} onChange={(e) => touch({ content: { ...latest.current.content, [f.key]: e.target.value }, risk: latest.current.risk })} />
        ))}

        <fieldset className="mb-6 rounded-card border border-line bg-surface p-5">
          <legend className="px-2 text-lg font-semibold">Risk</legend>
          <p className="mb-4 text-ink-muted">
            Risk flags prompt your professional assessment; they do not diagnose. A moderate or high level adds a follow-up task to your task list. The task never contains your risk notes.
          </p>
          <Select id="risk-level" label="Risk level" value={risk.level}
                  onChange={(e) => touch({ content: latest.current.content, risk: { ...latest.current.risk, level: e.target.value as RiskLevel } })}>
            {RISK_LEVELS.map((l) => <option key={l} value={l}>{RISK_LABEL[l]}</option>)}
          </Select>
          <Textarea id="risk-notes" label="Risk notes" rows={4} maxLength={NOTE_FIELD_MAX} value={risk.notes}
                    hint="What you observed and the steps you are taking."
                    onChange={(e) => touch({ content: latest.current.content, risk: { ...latest.current.risk, notes: e.target.value } })} />
        </fieldset>

        {!confirming ? (
          <Button type="button" onClick={() => setConfirming(true)} disabled={state.phase === "conflict"}>Sign note</Button>
        ) : (
          <FocusOnMount id="sign-panel" className="rounded-card border-2 border-sage-700 bg-surface p-5">
            <div>
              <h2 className="mb-2 text-lg">Sign this note?</h2>
              <p className="mb-2">Signing makes the note permanent. You will not be able to change what you have written. If something needs correcting later, you add an addendum, and the original text stays as it was.</p>
              <p className="mb-4 text-ink-muted">Your name and the time are recorded with the signature.</p>
              <div className="flex flex-wrap gap-3">
                <Button type="button" onClick={confirmSign} loading={signing}>{signing ? "Signing…" : "Sign and lock note"}</Button>
                <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={signing}>Keep editing</Button>
              </div>
            </div>
          </FocusOnMount>
        )}
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
        <p role="status" aria-live="polite" className={state.phase === "error" || state.phase === "conflict" ? "font-medium text-danger" : undefined}>
          {noteSaveText(state.phase, state.savedAt, sastTime)}
        </p>
        {state.phase === "error" && <Button type="button" variant="quiet" onClick={() => void save()} className="min-h-11">Retry saving</Button>}
        {state.phase === "conflict" && <Button type="button" variant="quiet" onClick={() => window.location.reload()} className="min-h-11">Reload the note</Button>}
      </div>
    </div>
  );
}
