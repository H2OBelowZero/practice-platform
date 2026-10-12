import { PublicShell } from "@/components/shell/public-shell";
import { LinkButton } from "@/components/ui/button";

// Also what requireRole() renders for a role that may not see an area, so the copy must not hint that the page exists.
export default function NotFound() {
  return (
    <PublicShell narrow>
      <h1>Page not found</h1>
      <p className="mt-3 text-ink-muted">We could not find that page. It may have moved, or the link may be incorrect.</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <LinkButton href="/">Go to the home page</LinkButton>
        <LinkButton href="/login" variant="secondary">Sign in</LinkButton>
      </div>
    </PublicShell>
  );
}
