"use client";

import "./globals.css";

/** Last-resort boundary: replaces the root layout, so it brings its own <html>. Same rules as app/error.tsx: no message, no stack. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-ZA">
      <body>
        <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-4 py-10 sm:px-8">
          <h1>Something went wrong</h1>
          <p className="mt-3 text-ink-muted">The page could not be shown. Please try again, and if it keeps happening contact the practice.</p>
          {error.digest && <p className="mt-4 text-sm text-ink-muted">Reference for the practice: <code>{error.digest}</code></p>}
          <div className="mt-6">
            <button type="button" onClick={() => reset()} className="inline-flex min-h-11 items-center rounded-xl bg-sage-700 px-5 py-2 font-medium text-white">Try again</button>
          </div>
        </main>
      </body>
    </html>
  );
}
