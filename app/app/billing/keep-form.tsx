"use client";

import { useActionState, startTransition } from "react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-error";
import type { ActionState, Values } from "@/lib/appointments/types";

/**
 * Like ActionForm, but submitted with onSubmit instead of the form `action` prop, so React does NOT clear the fields when the server answers
 * with an error. A long invoice (several lines) must survive a validation message. Success redirects, as with ActionForm.
 */
export function KeepForm<A extends unknown[]>({ action, args, children, submitLabel, pendingLabel, variant }: {
  action: (...a: [...A, Values]) => Promise<ActionState>; args: A; children: React.ReactNode;
  submitLabel: string; pendingLabel?: string; variant?: ButtonVariant;
}) {
  const [state, run, pending] = useActionState(async (_p: ActionState, fd: FormData): Promise<ActionState> => {
    const values: Values = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") values[k] = v;
    return action(...args, values);
  }, null);
  return (
    <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); startTransition(() => run(fd)); }}>
      <FormError message={state?.error} state={state} />
      {children}
      <Button type="submit" variant={variant} loading={pending}>{pending && pendingLabel ? pendingLabel : submitLabel}</Button>
    </form>
  );
}
