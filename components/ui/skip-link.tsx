/** First focusable element on every page: jumps over navigation to <main id="main">. Visible only when focused. */
export function SkipLink({ href = "#main" }: { href?: string }) {
  return (
    <a href={href}
       className="sr-only z-50 rounded-xl bg-sage-900 px-4 py-3 font-medium text-white focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:text-white">
      Skip to main content
    </a>
  );
}
