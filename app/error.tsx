"use client";

import { useState } from "react";
import { Button, LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Error boundary for everything under the root layout. Deliberately shows NO error message or stack (they can contain
 * names, SQL or clinical context). The digest is a hash that lets the practice find the server log line; it is shown only
 * as a copyable reference.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [copied, setCopied] = useState(false);
  const ref = error.digest;
  const copy = async () => {
    try { await navigator.clipboard.writeText(ref ?? ""); setCopied(true); } catch { /* the code is selectable text as a fallback */ }
  };
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10 sm:px-8">
      <Card>
        <h1>Something went wrong</h1>
        <p className="mt-3 text-ink-muted">
          We could not complete that. Nothing you did has been lost or shared. Please try again, and if it keeps happening contact the practice.
        </p>
        {ref && (
          <p className="mt-4 text-sm text-ink-muted">
            Reference for the practice: <code className="rounded bg-sunk px-1.5 py-0.5 text-ink">{ref}</code>{" "}
            <button type="button" onClick={copy} className="text-blue-700 underline underline-offset-4">{copied ? "Copied" : "Copy"}</button>
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => reset()}>Try again</Button>
          <LinkButton href="/" variant="secondary">Go to the home page</LinkButton>
        </div>
      </Card>
    </main>
  );
}
