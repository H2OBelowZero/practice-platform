"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestRecovery } from "../actions";
import { Field, FormError, Notice, SubmitButton } from "../ui";

export function RecoverForm() {
  const [state, action] = useActionState(requestRecovery, null);
  if (state?.done) {
    // Identical for every address, registered or not.
    return (
      <>
        <Notice>If that email address has an account, we have sent a link to reset the password. Check your inbox.</Notice>
        <p><Link href="/login" className="underline underline-offset-4">Back to sign in</Link></p>
      </>
    );
  }
  return (
    <form action={action} noValidate>
      <FormError state={state} />
      <Field id="email" label="Email address" type="email" autoComplete="email" inputMode="email" required
             hint="We will email you a link to choose a new password." invalid={Boolean(state?.error)} />
      <SubmitButton pendingLabel="Sending…">Send reset link</SubmitButton>
      <p className="mt-4"><Link href="/login" className="underline underline-offset-4">Back to sign in</Link></p>
    </form>
  );
}
