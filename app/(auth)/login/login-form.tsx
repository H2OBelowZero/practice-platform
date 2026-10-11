"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn } from "../actions";
import { Field, FormError, SubmitButton } from "../ui";

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(signIn, null);
  const invalid = Boolean(state?.error);
  return (
    <form action={action} noValidate>
      <FormError state={state} />
      {next && <input type="hidden" name="next" value={next} />}
      <Field id="email" label="Email address" type="email" autoComplete="username" inputMode="email" required
             defaultValue={state?.email} invalid={invalid} />
      <Field id="password" label="Password" type="password" autoComplete="current-password" required invalid={invalid} />
      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      <p className="mt-4"><Link href="/recover" className="underline underline-offset-4">Forgotten your password?</Link></p>
    </form>
  );
}
