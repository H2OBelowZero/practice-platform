"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { startPayfastCheckout, type CheckoutResult } from "./actions";

type Ready = Extract<CheckoutResult, { ok: true }>;

/**
 * The "Pay now" control. Clicking asks the server to start the checkout (it recomputes the amount from the database; `amountCents` here is only
 * what the page displayed, sent so the server can refuse if the balance has moved). The signed fields that come back are put into a real
 * <form method="post"> that is submitted to PayFast; "Continue to PayFast" is there too in case the automatic submit is blocked.
 * Nothing is marked paid here: the return page only shows stored status.
 */
export function PayNow({ invoiceId, amountLabel, amountCents, invoiceNumber }: { invoiceId: string; amountLabel: string; amountCents: number; invoiceNumber: string }) {
  const [pending, start] = useTransition();
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (ready) formRef.current?.submit(); }, [ready]);
  useEffect(() => { if (error) errRef.current?.focus(); }, [error]);

  const click = () => {
    setError(null);
    start(async () => {
      try {
        const r = await startPayfastCheckout(invoiceId, amountCents);
        if (r.ok) setReady(r); else setError(r.error);
      } catch { setError("Something went wrong and nothing was charged. Please try again, or contact the practice."); }
    });
  };

  return (
    <div>
      <p className="mb-3">You will be taken to PayFast to pay <strong>{amountLabel}</strong>.</p>
      {error && <Notice ref={errRef} tone="error" focusable>{error}</Notice>}
      {ready ? (
        <form ref={formRef} method="post" action={ready.action}>
          {Object.entries(ready.fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <p role="status" className="mb-3 text-ink-muted">Taking you to PayFast…</p>
          <Button type="submit" variant="secondary">Continue to PayFast</Button>
        </form>
      ) : (
        <Button onClick={click} loading={pending} aria-label={`Pay now: ${amountLabel} for invoice ${invoiceNumber}`}>Pay now</Button>
      )}
    </div>
  );
}
