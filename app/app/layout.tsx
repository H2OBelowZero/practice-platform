import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { getPractice } from "@/lib/practice";
import { staffNav, staffPhoneNav } from "@/lib/nav";
import { SkipLink } from "@/components/ui/skip-link";
import { NavLinks } from "@/components/shell/nav-links";
import { SignOutButton } from "@/components/shell/sign-out";

export const metadata = { robots: { index: false, follow: false } };

// The layout gates the whole workspace, but is NOT the authorisation: every page and server action under /app calls requireRole itself (R26).
export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const me = await requireRole(["psychologist", "admin", "bookkeeper", "associate"]);
  const practice = await getPractice();
  const brand = practice?.name ?? "Practice";

  return (
    <div className="min-h-screen lg:flex">
      <div className="no-print"><SkipLink /></div>
      {/* phones and tablets: slim header, bottom navigation */}
      <header className="on-dark flex items-center no-print justify-between bg-sage-900 px-4 py-3 text-white lg:hidden">
        <Link href="/app" className="font-serif text-lg font-semibold text-white no-underline hover:text-white">{brand}</Link>
        <span className="text-sm capitalize text-sage-200">{me.role}</span>
      </header>
      {/* desktop: sidebar */}
      <aside className="on-dark hidden no-print w-64 shrink-0 flex-col bg-sage-900 px-3 py-6 text-white lg:sticky lg:top-0 lg:flex lg:h-screen">
        <Link href="/app" className="mb-1 px-3 font-serif text-xl font-semibold text-white no-underline hover:text-white">{brand}</Link>
        <p className="mb-6 px-3 text-sm capitalize text-sage-200">{me.role} workspace</p>
        <NavLinks items={staffNav(me.role)} variant="sidebar" label="Main" />
        <div className="mt-auto border-t border-sage-800 pt-3"><SignOutButton dark /></div>
      </aside>
      <div className="has-bottom-nav min-w-0 flex-1 bg-canvas text-ink">
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-8 lg:py-12">{children}</main>
      </div>
      <div className="on-dark fixed inset-x-0 no-print bottom-0 z-40 border-t border-sage-800 bg-sage-900 pb-[env(safe-area-inset-bottom)] lg:hidden">
        <NavLinks items={staffPhoneNav(me.role)} variant="bottom" label="Main (phone)" />
      </div>
    </div>
  );
}
