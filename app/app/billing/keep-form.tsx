"use client";

import { createContext, useActionState, useEffect, useRef, useState, startTransition } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import type { ActionState, Values } from "@/lib/appointments/types";

/** The server's error for one field (id of the control), so the control can be marked aria-invalid and carry the message. */
export const FieldErrorContext = createContext<{ field?: string; error?: string }>({});

/**
 * Like ActionForm, but submitted with onSubmit instead of the form `action` prop, so React does NOT clear the fields when the server answers
 * with an error. A long invoice (several lines) must survive a validation message. Success redirects, as with ActionForm.
 * `confirm` adds an inline confirmation step (no browser dialog): the first submit shows the panel (focus moves to it), "Yes" sends the form.
 */
export function KeepForm<A extends unknown[]>({ action, args, children, submitLabel, pendingLabel, variant, confirm }: {
  action: (...a: [...A, Values]) => Promise<ActionState>; args: A; children?: React.ReactNode;
  submitLabel: string; pendingLabel?: string; variant?: ButtonVariant;
  confirm?: { title: string; body: React.ReactNode; yes: string; variant?: ButtonVariant };
}) {
  const [state, run, pending] = useActionState(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
    const values: Values = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") values[k] = v;
    return action(...args, values);
  }, null);
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (confirming) panelRef.current?.focus(); }, [confirming]);
  const send = () => { setConfirming(false); startTransition(() => run(new FormData(formRef.current!))); };

  return (
    <FieldErrorContext.Provider value={{ field: state?.field, error: state?.error }}>
      <form ref={formRef} onSubmit={(e) => { e.preventDefault(); if (confirm) setConfirming(true); else send(); }}>
        <FormError message={state?.error} state={state} />
        {children}
        {confirming && confirm ? (
          <div ref={panelRef} tabIndex={-1} role="group" aria-label={confirm.title} className="rounded-card border border-line-strong bg-sunk p-5">
            <h3 className="mb-2 text-lg">{confirm.title}</h3>
            <div className="mb-4">{confirm.body}</div>
            <div className="flex flex-wrap gap-3">
              <Button variant={confirm.variant ?? variant} loading={pending} onClick={send}>{confirm.yes}</Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>No, go back</Button>
            </div>
          </div>
        ) : (
          <Button type="submit" variant={variant} loading={pending}>{pending && pendingLabel ? pendingLabel : submitLabel}</Button>
        )}
      </form>
    </FieldErrorContext.Provider>
  );
}
