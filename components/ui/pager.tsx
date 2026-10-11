import { LinkButton } from "./button";

/**
 * Previous / next links with a text summary ("Showing 26 to 50 of 61"). Plain links, so it works without JavaScript.
 * A disabled end is shown as text, not a dead link. `hrefFor(page)` builds the URL of a page.
 */
export function Pager({ page, pages, total, from, to, hrefFor, label }: {
  page: number; pages: number; total: number; from: number; to: number; hrefFor: (page: number) => string; label: string;
}) {
  if (total === 0) return null;
  return (
    <nav aria-label={label} className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <p className="text-ink-muted">Showing {from + 1} to {Math.min(to + 1, total)} of {total} · Page {page} of {pages}</p>
      <div className="flex gap-2">
        {page > 1 ? <LinkButton variant="secondary" href={hrefFor(page - 1)} rel="prev">Previous page</LinkButton> : <span className="inline-flex min-h-11 items-center px-5 text-ink-muted">Previous page</span>}
        {page < pages ? <LinkButton variant="secondary" href={hrefFor(page + 1)} rel="next">Next page</LinkButton> : <span className="inline-flex min-h-11 items-center px-5 text-ink-muted">Next page</span>}
      </div>
    </nav>
  );
}
