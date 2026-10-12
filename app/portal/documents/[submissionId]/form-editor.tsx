"use client";

import { useCallback, useEffect, useReducer, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AUTOSAVE_DELAY_MS, autosaveReducer, autosaveText, hasUnsaved, initialAutosave } from "@/lib/forms/autosave";
import { FORM_ERROR } from "@/lib/forms/errors";
import { FormRenderer, fieldDomId, firstErrorKey, type AnswerValue, type Answers } from "@/lib/forms/render";
import type { FormSchema } from "@/lib/forms/validate";
import { sastTime } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { saveDraft, submitForm, type SubmitResult } from "../actions";

const focusField = (key: string) => document.getElementById(fieldDomId(key))?.focus();

/**
 * The editor for an open (draft or returned) form. The answers live in state; every change restarts a 1.5 s timer and then saves a draft through
 * the saveDraft action. Nothing is lost on a failed save: the answers stay on screen, the status line says so and Retry saves again.
 * A save carries the `updated_at` it last saw: if the form was saved elsewhere meanwhile the server refuses (nothing is overwritten) and the editor stops
 * autosaving and asks the person to reload.
 * "Save and finish later" saves now and leaves; "Submit" runs the full server-side check; a failed submit lists the problems as links and moves focus to the
 * first invalid field. While something is unsaved the browser warns before the tab is closed or reloaded (beforeunload), and a save is attempted when the tab is hidden.
 */
export function FormEditor({ submissionId, schema, initial, updatedAt }: { submissionId: string; schema: FormSchema; initial: Answers; updatedAt: string }) {
  const router = useRouter();
  const [values, setValues] = useState<Answers>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(autosaveReducer, initialAutosave);
  const [submitting, startSubmit] = useTransition();
  const [leaving, setLeaving] = useState(false);

  const latest = useRef(values);
  const seen = useRef(updatedAt); // the updated_at of the version this editor last loaded or saved
  const busy = useRef(false); // a submit or a leave is under way: no more autosaves
  const inFlight = useRef(false); // one save at a time (a second would carry a stale `seen`)
  const phase = useRef(state.phase);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { phase.current = state.phase; }, [state.phase]);

  /** Save the answers on screen now. Resolves true when stored. */
  const save = useCallback(async (): Promise<boolean> => {
    if (busy.current || inFlight.current || phase.current === "conflict") return false;
    inFlight.current = true;
    dispatch({ type: "save_start" });
    try {
      const r = await saveDraft(submissionId, latest.current, seen.current);
      if (r.ok) { seen.current = r.at; dispatch({ type: "save_ok", at: r.at }); return true; }
      if (r.conflict) dispatch({ type: "save_conflict" });
      else {
        dispatch({ type: "save_fail" });
        if (r.error === FORM_ERROR.closed) setFormError(r.error); // retrying cannot help; every other failure shows in the status line
      }
    } catch {
      dispatch({ type: "save_fail" });
    } finally { inFlight.current = false; }
    return false;
  }, [submissionId]);

  const onChange = (key: string, v: AnswerValue) => {
    const next = { ...latest.current, [key]: v };
    latest.current = next;
    setValues(next);
    setErrors((e) => (e[key] ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)) : e));
    dispatch({ type: "change" });
  };

  // the 1.5 s debounce: restarts on every change (rev), runs once the typing pauses. A timer that fires while a submit is pending
  // waits and tries again, so an edit made during a submit is not left unsaved when the submit fails.
  useEffect(() => {
    if (state.phase !== "dirty") return;
    let t: ReturnType<typeof setTimeout>;
    const run = () => { if (busy.current) t = setTimeout(run, AUTOSAVE_DELAY_MS); else void save(); };
    t = setTimeout(run, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state.phase, state.rev, save]);

  // leaving the page with unsaved answers: ask first (full unloads), and try to save when the tab is hidden
  const unsaved = hasUnsaved(state);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const hidden = () => { if (document.visibilityState === "hidden") void save(); };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("visibilitychange", hidden); };
  }, [unsaved, save]);

  // a message with no field to point at (closed, server trouble) takes focus; one with field errors leaves focus on the first invalid field
  const hasFieldErrors = Object.keys(errors).length > 0;
  useEffect(() => { if (formError && !hasFieldErrors) errorRef.current?.focus(); }, [formError, hasFieldErrors]);

  const retry = () => { setFormError(null); void save(); };

  const finishLater = async () => {
    setFormError(null);
    setLeaving(true);
    const nothingToSave = phase.current === "idle" || phase.current === "saved";
    const ok = nothingToSave || (await save());
    if (ok) { busy.current = true; router.push("/portal/documents?notice=saved"); }
    else setLeaving(false);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (phase.current === "conflict") { setFormError(FORM_ERROR.conflict); return; } // submitting would overwrite what was saved elsewhere
    setFormError(null);
    busy.current = true; // no autosave may land after the submit
    startSubmit(async () => {
      let r: SubmitResult | undefined;
      try { r = (await submitForm(submissionId, latest.current)) as SubmitResult | undefined; } // success redirects: nothing comes back
      catch { r = { ok: false, error: "We could not reach the server. Your answers are still on screen; please try again.", errors: {} }; }
      busy.current = false;
      if (!r) return;
      setErrors(r.errors);
      setFormError(r.error);
      const first = firstErrorKey(schema, r.errors);
      if (first) focusField(first);
      if (phase.current === "dirty" || phase.current === "error") void save(); // keep what was typed during the submit
    });
  };

  const listed = schema.fields.filter((f) => errors[f.key]);

  return (
    <form onSubmit={onSubmit} noValidate>
      {formError && (
        <Notice ref={errorRef} tone="error" focusable>
          <p>{formError}</p>
          {listed.length > 0 && (
            <ul className="mt-2 list-disc pl-5">
              {listed.map((f) => (
                <li key={f.key}>
                  <a href={`#${fieldDomId(f.key)}`} onClick={(e) => { e.preventDefault(); focusField(f.key); }}>{f.label}</a>: {errors[f.key]}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}
      <FormRenderer schema={schema} values={values} errors={errors} onChange={onChange} />

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Button type="submit" loading={submitting} disabled={leaving}>{submitting ? "Submitting…" : "Submit"}</Button>
        <Button type="button" variant="secondary" onClick={finishLater} loading={leaving} disabled={submitting}>Save and finish later</Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-ink-muted">
        <p role="status" aria-live="polite" className={state.phase === "error" || state.phase === "conflict" ? "font-medium text-danger" : undefined}>
          {autosaveText(state, sastTime)}
        </p>
        {state.phase === "error" && <Button type="button" variant="quiet" onClick={retry} className="min-h-11">Retry saving</Button>}
        {state.phase === "conflict" && <Button type="button" variant="quiet" onClick={() => window.location.reload()} className="min-h-11">Reload the form</Button>}
      </div>
    </form>
  );
}
