"use client";

import { useEffect, useRef, type InputHTMLAttributes } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "./actions";

// Small shared form pieces for the auth pages (a design pass comes later). Errors are text, never colour alone,
// and the error summary takes focus when a submit fails.

export const ERROR_ID = "form-error";

export function FormError({ state }: { state: FormState }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (state?.error) ref.current?.focus(); }, [state]); // state is a new object on every submit
  if (!state?.error) return null;
  return (
    <p id={ERROR_ID} ref={ref} tabIndex={-1} role="alert"
       className="mb-4 border-l-4 border-red-700 bg-red-50 p-3 text-red-900 outline-offset-2 focus:outline-2 focus:outline-red-700">
      <strong>Error: </strong>{state.error}
    </p>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="mb-4 border-l-4 border-green-800 bg-green-50 p-3 text-green-950">
      <strong>Note: </strong>{children}
    </p>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint?: string; invalid?: boolean };

export function Field({ id, label, hint, invalid, ...input }: FieldProps) {
  const describedBy = [hint ? `${id}-hint` : null, invalid ? ERROR_ID : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block font-medium">{label}</label>
      <input id={id} name={id} aria-describedby={describedBy} aria-invalid={invalid || undefined}
             className="block min-h-11 w-full rounded border border-neutral-600 bg-white px-3 py-2 text-black"
             {...input} />
      {hint && <p id={`${id}-hint`} className="mt-1 text-sm">{hint}</p>}
    </div>
  );
}

export function SubmitButton({ children, pendingLabel }: { children: React.ReactNode; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending}
            className="min-h-11 w-full rounded bg-blue-800 px-4 py-2 font-medium text-white hover:bg-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800 disabled:opacity-70">
      {pending ? pendingLabel : children}
    </button>
  );
}
