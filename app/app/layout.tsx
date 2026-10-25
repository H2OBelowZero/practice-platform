import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { getPractice } from "@/lib/practice";
import { staffNav, staffPhoneNav } from "@/lib/nav";
import { SkipLink } from "@/components/ui/skip-link";
import { NavLinks } from "@/components/shell/nav-links";
import { SignOutButton } from "@/components/shell/sign-out";
import { SidebarArcs, Wordmark } from "@/components/shell/ornament";

export const metadata = { robots: { index: false, follow: false } };

// The layout gates the whole workspace, but is NOT the authorisation: every page and server action under /app calls requireRole itself (R26).
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const me = await requireRole(["psychologist", "admin", "bookkeeper", "associate"]);
  const practice = await getPractice();
  const brand = practice?.name ?? "Practice";
  const workspace = `${me.role[0].toUpperCase()}${me.role.slice(1)} workspace`;

  return (
    <div className="min-h-screen lg:flex">
      <div className="no-print"><SkipLink /></div>
      {/* phones and tablets: slim header, bottom navigation */}
      <header className="on-dark no-print flex items-center justify-between gap-3 bg-sage-900 px-4 py-3 text-white lg:hidden">
        <Link href="/app" className="min-w-0 no-underline"><Wordmark name={brand} dark className="text-sm" /></Link>
        <span className="shrink-0 text-sm capitalize text-sage-300">{me.role}</span>
      </header>
      {/* desktop: sidebar */}
      <aside className="on-dark no-print relative hidden w-68 shrink-0 flex-col overflow-hidden bg-sage-900 px-4 py-7 text-white lg:sticky lg:top-0 lg:flex lg:h-screen">
        <SidebarArcs className="absolute inset-x-0 bottom-0 h-56 w-full" />
        <Link href="/app" className="relative mb-9 rounded-xl px-2 text-base no-underline">
          <Wordmark name={brand} tagline={workspace} dark />
        </Link>
        <div className="relative min-h-0 flex-1 overflow-y-auto"><NavLinks items={staffNav(me.role)} variant="sidebar" label="Main" /></div>
        <div className="relative mt-4 border-t border-white/10 pt-3"><SignOutButton dark /></div>
      </aside>
      <div className="has-bottom-nav min-w-0 flex-1 bg-canvas text-ink">
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 lg:px-10 lg:py-11">{children}</main>
      </div>
      <div className="on-dark no-print fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-sage-900 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <NavLinks items={staffPhoneNav(me.role)} variant="bottom" label="Main (phone)" />
      </div>
    </div>
  );
}
