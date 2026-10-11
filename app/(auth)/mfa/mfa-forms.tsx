"use client";

import { useActionState, useRef, useEffect } from "react";
import { startMfaEnrolment, verifyMfa, type FormState } from "../actions";
import { Button } from "@/components/ui/button";
import { Field, FormError, SubmitButton } from "../ui";

function CodeForm({ factorId, next, state, action }: {
  factorId: string; next: string; state: FormState; action: (fd: FormData) => void;
}) {
  return (
    <form action={action} noValidate>
      <FormError state={state} />
      <input type="hidden" name="factorId" value={factorId} />
      <input type="hidden" name="next" value={next} />
      <Field id="code" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={7} required
             invalid={Boolean(state?.error)} />
      <SubmitButton pendingLabel="Checking…">Verify and continue</SubmitButton>
    </form>
  );
}

/** Challenge for a user who already has a verified authenticator. */
export function MfaVerify({ factorId, next }: { factorId: string; next: string }) {
  const [state, action] = useActionState(verifyMfa, null);
  return <CodeForm factorId={factorId} next={next} state={state} action={action} />;
}

/** First-time setup: create the factor (QR + secret), then verify one code. */
export function MfaEnrol({ next }: { next: string }) {
  const [enrolState, enrol, enrolPending] = useActionState(async () => startMfaEnrolment(), null as FormState);
  const [verifyState, verify] = useActionState(verifyMfa, null);
  const info = enrolState?.enrol;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (info) heading.current?.focus(); }, [info]); // move focus to the QR step when it appears

  if (!info) {
    return (
      <form action={enrol}>
        <FormError state={enrolState} />
        <Button type="submit" loading={enrolPending} className="w-full">
          {enrolPending ? "Preparing…" : "Set up authenticator app"}
        </Button>
      </form>
    );
  }
  return (
    <>
      <h2 ref={heading} tabIndex={-1} className="mb-2">Scan, then confirm</h2>
      <ol className="mb-4 list-decimal space-y-2 pl-5">
        <li>In your authenticator app, add an account and scan this QR code.</li>
        <li>
          Cannot scan? Enter this key instead:{" "}
          <code className="break-all rounded bg-sunk px-1.5 py-0.5 text-ink select-all">{info.secret}</code>
        </li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      {/* eslint-disable-next-line @next/next/no-img-element -- data: URI from Supabase, nothing to optimise */}
      <img src={info.qr} alt="QR code to add this account to your authenticator app" width={192} height={192}
           className="mb-4 h-48 w-48 bg-white p-2" />
      <CodeForm factorId={info.factorId} next={next} state={verifyState} action={verify} />
    </>
  );
}
