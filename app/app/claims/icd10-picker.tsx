"use client";

import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { filterIcd10, type Icd10 } from "@/lib/claims/icd10";

/**
 * Searchable multi-select for ICD-10 codes: a search box that narrows a list of check boxes (native controls, so keyboard and screen reader behaviour
 * is the browser's own), a "Selected" list with a Remove button per code, and one hidden field `icd10` holding the chosen codes ("F41.1,F32.9") for the form.
 * The list is the practice's icd10_codes table, loaded by the page (a short clinical list; filtering is in the browser, so very large code sets would need a server search).
 * `disabled` (the admin cannot write diagnosis codes) shows the explanation and keeps the control inert; the hidden field still carries the current codes unchanged.
 * Codes are clinical information: this component never logs them, never puts them in a URL and keeps them only in this form.
 */
export function Icd10Picker({ codes, initial, disabled = false, error }: { codes: Icd10[]; initial: string[]; disabled?: boolean; error?: string }) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>(initial);
  const shown = useMemo(() => filterIcd10(codes, query), [codes, query]);
  const toggle = (code: string) => setChosen((c) => (c.includes(code) ? c.filter((x) => x !== code) : [...c, code]));
  const describedBy = [`${uid}-hint`, error ? `${uid}-error` : null].filter(Boolean).join(" ");

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
          <input id={`${uid}-q`} type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" maxLength={60} placeholder="for example F41 or anxiety"
                 aria-controls={`${uid}-list`} className="block min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2 text-base text-ink placeholder:text-ink-muted" />
          <p role="status" className="mt-1 text-sm text-ink-muted">{shown.length === 0 ? "No codes match that search." : `${shown.length} of ${codes.length} codes shown.`}</p>
        </div>
      )}

      <div id={`${uid}-list`} className="mb-3 max-h-64 overflow-y-auto rounded-xl border border-line">
        {shown.length === 0 ? <p className="p-3 text-ink-muted">{codes.length === 0 ? "The code list is empty." : "No codes to show."}</p> : (
          <ul className="m-0 list-none p-0">
            {shown.map((c) => (
              <li key={c.code} className="border-b border-line last:border-b-0">
                <label className="flex min-h-11 cursor-pointer items-start gap-3 px-3 py-2 has-[:disabled]:cursor-default">
                  <input type="checkbox" checked={chosen.includes(c.code)} onChange={() => toggle(c.code)} className="mt-1 size-5 shrink-0 accent-sage-700" />
                  <span><span className="font-medium">{c.code}</span><span className="text-ink-muted"> · {c.description}</span></span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div aria-live="polite">
        <p className="mb-1 font-medium">Selected ({chosen.length})</p>
        {chosen.length === 0 ? <p className="text-ink-muted">No codes selected.</p> : (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {chosen.map((code) => (
              <li key={code} className="inline-flex items-center gap-1 rounded-2xl bg-sage-100 py-0.5 pl-3 text-sm font-medium text-sage-900">
                <Icon name="check" />{code}
                {!disabled && <Button variant="quiet" className="min-h-9 px-3 py-0 text-sm" onClick={() => toggle(code)} aria-label={`Remove ${code}`}>Remove</Button>}
                {disabled && <span className="pr-3" />}
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
    <input type="hidden" name="icd10" value={chosen.join(",")} />
    </>
  );
}
