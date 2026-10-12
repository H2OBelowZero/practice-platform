"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ICD10_RESULTS_MAX, type Icd10 } from "@/lib/claims/icd10";
import { searchIcd10 } from "./actions";

const DEBOUNCE_MS = 300;

/**
 * Searchable multi-select for ICD-10 codes. A labelled search box asks the server (searchIcd10: psychologist only, at most 50 results) after a short pause in typing;
 * the matches are native check boxes (keyboard and screen reader behaviour is the browser's own) and a live status line says what is happening. Chosen codes keep
 * their description (from the claim or from the search that found them) in a "Selected" list with a Remove button per code, and one hidden field \`icd10\` holds the
 * chosen codes ("F41.1,F32.9") for the form. \`disabled\` (the admin cannot write diagnosis codes) shows the explanation and keeps the control inert; the hidden field
 * still carries the current codes unchanged. Codes are clinical information: this component never logs them or puts them in a URL.
 */
export function Icd10Picker({ initial, disabled = false, error }: { initial: Icd10[]; disabled?: boolean; error?: string }) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Icd10[]>(initial);
  const [results, setResults] = useState<Icd10[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const mine = ++seq.current; // a slower, older answer must not replace a newer one
    if (disabled || q === "") { setResults(null); setState("idle"); setMessage(""); return; }
    setState("loading");
    const t = setTimeout(async () => {
      const r = await searchIcd10(q).catch(() => null);
      if (mine !== seq.current) return;
      if (!r || !r.ok) { setState("error"); setMessage(r && !r.ok ? r.error : "We could not search the code list. Please try again."); return; }
      setResults(r.codes); setState("idle"); setMessage("");
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, disabled]);

  const has = (code: string) => chosen.some((c) => c.code === code);
  const toggle = (c: Icd10) => setChosen((cur) => (cur.some((x) => x.code === c.code) ? cur.filter((x) => x.code !== c.code) : [...cur, c]));
  const describedBy = [`${uid}-hint`, error ? `${uid}-error` : null].filter(Boolean).join(" ");
  const status = state === "loading" ? "Searching…" : state === "error" ? message
    : results === null ? "" : results.length === 0 ? "No codes match that search."
    : results.length >= ICD10_RESULTS_MAX ? `The first ${ICD10_RESULTS_MAX} matches are shown. Type more to narrow the search.` : `${results.length} ${results.length === 1 ? "code" : "codes"} found.`;

  return (
    <>
    <fieldset id="icd10" disabled={disabled} aria-describedby={describedBy} aria-invalid={error ? true : undefined} className="mb-5 min-w-0 rounded-xl border border-line p-4">
      <legend className="px-2 font-medium">Diagnosis codes (ICD-10) <span className="ml-1 rounded-2xl bg-grey-tint px-2 py-0.5 text-xs font-medium text-grey-ink">Clinical information</span></legend>
      <p id={`${uid}-hint`} className="mb-3 text-sm text-ink-muted">
        {disabled ? "Diagnosis codes are added by the practitioner. You can see the codes already added, but not change them." : "Search by code or name, then tick every code that applies. At least one is needed before the claim can be marked as submitted."}
      </p>

      {!disabled && (
        <div className="mb-3">
          <label htmlFor={`${uid}-q`} className="mb-1 block font-medium">Search the code list</label>
          <input id={`${uid}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" maxLength={40} placeholder="for example F41 or anxiety"
                 aria-controls={`${uid}-list`} className="block min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2 text-base text-ink placeholder:text-ink-muted" />
          <p role="status" className={`mt-1 text-sm ${state === "error" ? "font-medium text-danger" : "text-ink-muted"}`}>{status}</p>
        </div>
      )}

      {!disabled && results !== null && results.length > 0 && (
        <div id={`${uid}-list`} aria-busy={state === "loading"} className="mb-3 max-h-64 overflow-y-auto rounded-xl border border-line">
          <ul className="m-0 list-none p-0">
            {results.map((c) => (
              <li key={c.code} className="border-b border-line last:border-b-0">
                <label className="flex min-h-11 cursor-pointer items-start gap-3 px-3 py-2">
                  <input type="checkbox" checked={has(c.code)} onChange={() => toggle(c)} className="mt-1 size-5 shrink-0 accent-sage-700" />
                  <span><span className="font-medium">{c.code}</span><span className="text-ink-muted"> · {c.description}</span></span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div aria-live="polite">
        <p className="mb-1 font-medium">Selected ({chosen.length})</p>
        {chosen.length === 0 ? <p className="text-ink-muted">No codes selected.</p> : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {chosen.map((c) => (
              <li key={c.code} className="flex flex-wrap items-center gap-x-2">
                <Icon name="check" /><span className="font-medium">{c.code}</span>{c.description && <span className="text-ink-muted">· {c.description}</span>}
                {!disabled && <Button variant="quiet" className="min-h-9 px-3 py-0 text-sm" onClick={() => toggle(c)} aria-label={`Remove ${c.code}`}>Remove</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p id={`${uid}-error`} className="mt-3 flex items-start gap-1.5 text-sm font-medium text-danger">
          <Icon name="alert" className="mt-0.5" /><span><span className="sr-only">Error: </span>{error}</span>
        </p>
      )}
    </fieldset>
    {/* outside the fieldset: a disabled fieldset would stop the field from being sent */}
    <input type="hidden" name="icd10" value={chosen.map((c) => c.code).join(",")} />
    </>
  );
}
