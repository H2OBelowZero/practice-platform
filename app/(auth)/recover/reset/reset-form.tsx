"use client";

import { useActionState } from "react";
import { resetPassword } from "../../actions";
import { Field, FormError, SubmitButton } from "../../ui";

export function ResetForm() {
  const [state, action] = useActionState(resetPassword, null);
  const invalid = Boolean(state?.error);
  return (
    <form action={action} noValidate>
      <FormError state={state} />
      <Field id="password" label="New password" type="password" autoComplete="new-password" required minLength={12} maxLength={72}
             hint="At least 12 characters." invalid={invalid} />
      <Field id="confirm" label="Confirm new password" type="password" autoComplete="new-password" required invalid={invalid} />
      <SubmitButton pendingLabel="Saving…">Set new password</SubmitButton>
    </form>
  );
}
