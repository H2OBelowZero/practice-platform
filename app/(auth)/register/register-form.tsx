"use client";

import { useActionState } from "react";
import Link from "next/link";
import { register } from "../actions";
import { Field, FormError, Notice, SubmitButton } from "../ui";

export function RegisterForm({ next }: { next?: string }) {
  const [state, action] = useActionState(register, null);
  if (state?.done) {
    // Identical for every address, new or already registered.
    return (
      <>
        <Notice>Check your email to confirm your account. Once you have confirmed it, you can sign in{next ? " and carry on with your booking" : ""}.</Notice>
        <p className="text-sm text-ink-muted">Nothing arrived after a few minutes? Check your spam folder.</p>
      </>
    );
  }
  const invalid = Boolean(state?.error);
  return (
    <form action={action} noValidate>
      <FormError state={state} />
      {next && <input type="hidden" name="next" value={next} />}
      <Field id="name" label="Full name" autoComplete="name" required defaultValue="" invalid={invalid} />
      <Field id="email" label="Email address" type="email" autoComplete="username" inputMode="email" required defaultValue={state?.email} invalid={invalid} />
      <Field id="password" label="Password" type="password" autoComplete="new-password" required minLength={12} maxLength={72}
             hint="At least 12 characters. A few random words make a strong, memorable password." invalid={invalid} />
      <SubmitButton pendingLabel="Creating account…">Create account</SubmitButton>
      <p className="mt-4">Already have an account? <Link href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}>Sign in</Link></p>
    </form>
  );
}
