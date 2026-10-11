import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { getCrisisText, getPractice } from "@/lib/practice";
import { portalNav } from "@/lib/nav";
import { SkipLink } from "@/components/ui/skip-link";
import { EmergencyNotice } from "@/components/ui/emergency-notice";
import { NavLinks } from "@/components/shell/nav-links";
import { SignOutButton } from "@/components/shell/sign-out";

// The layout gates the portal, but is NOT the authorisation: every page and server action under /portal calls requireRole itself (R26).
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  await requireRole(["patient", "guardian"]);
  const [practice, crisis] = await Promise.all([getPractice(), getCrisisText()]);
  const items = portalNav();

  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <Link href="/portal" className="font-serif text-lg font-semibold text-sage-700 no-underline hover:text-sage-800">{practice?.name ?? "Practice"}</Link>
          <div className="hidden items-center gap-2 lg:flex">
            <NavLinks items={items} variant="top" label="Main" />
            <SignOutButton className="w-auto" />
          </div>
          <div className="lg:hidden"><SignOutButton className="w-auto" /></div>
        </div>
      </header>
      <div className="has-bottom-nav flex-1">
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-8 lg:py-12">{children}</main>
        <footer className="mx-auto w-full max-w-4xl px-4 pb-8 sm:px-8"><EmergencyNotice text={crisis} /></footer>
      </div>
      <div className="on-dark fixed inset-x-0 bottom-0 z-40 border-t border-sage-800 bg-sage-900 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <NavLinks items={items} variant="bottom" label="Main (phone)" />
      </div>
    </div>
  );
}
