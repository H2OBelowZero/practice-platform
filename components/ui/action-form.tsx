"use client";

import { useActionState, useEffect, useRef } from "react";
import type { ActionState, Values } from "@/lib/appointments/types";
import { FormError } from "./form-error";
import { SubmitButton } from "./submit-button";
import type { ButtonVariant } from "./button";

type Common = { submitLabel: string; pendingLabel?: string; variant?: ButtonVariant; className?: string };

/**
 * A form that calls a server action. `args` are the leading arguments (for example the appointment id), the form's fields
 * follow as one plain object of strings. The action validates everything again with Zod; an error comes back as
 * { error } and takes focus in an error summary, success redirects. Works for any number of fields (children).
 */
export function ActionForm<A extends unknown[]>({ action, args, children, submitLabel, pendingLabel, variant, className }: Common & {
  action: (...a: [...A, Values]) => Promise<ActionState>; args: A; children?: React.ReactNode;
}) {
  const [state, run] = useActionState(
    async (_prev: ActionState, fd: FormData): Promise<ActionState> => {
      const values: Values = {};
      for (const [k, v] of fd.entries()) if (typeof v === "string") values[k] = v;
      return action(...args, values);
    },
    null,
  );
  return (
    <form action={run} className={className}>
      <FormError message={state?.error} state={state} />
      {children}
      <SubmitButton variant={variant} pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
    </form>
  );
}

/** A button that calls a server action with fixed arguments (no fields). */
export function ActionButton<A extends unknown[]>({ action, args, submitLabel, pendingLabel, variant, className }: Common & {
  action: (...a: A) => Promise<ActionState>; args: A;
}) {
  const [state, run] = useActionState(async (): Promise<ActionState> => action(...args), null);
  return (
    <form action={run} className={className}>
      <FormError message={state?.error} state={state} />
      <SubmitButton variant={variant} pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
    </form>
  );
}

/** Wraps a panel that appears after a click, and moves keyboard/screen-reader focus to it once. */
export function FocusOnMount({ children, className, id }: { children: React.ReactNode; className?: string; id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <div ref={ref} id={id} tabIndex={-1} className={className}>{children}</div>;
}
