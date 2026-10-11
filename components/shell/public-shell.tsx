import Link from "next/link";
import { cx } from "@/lib/cx";
import { getCrisisText } from "@/lib/practice";
import { SkipLink } from "@/components/ui/skip-link";
import { EmergencyNotice } from "@/components/ui/emergency-notice";
import { buttonClass } from "@/components/ui/button";

/** Shell for public pages (landing, booking): brand, two links, crisis notice in the footer. `narrow` suits single-column forms. */
export async function PublicShell({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  const crisis = await getCrisisText();
  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <Link href="/" className="font-serif text-lg font-semibold text-sage-700 no-underline hover:text-sage-800">Practice Platform</Link>
          <nav aria-label="Main" className="flex items-center gap-1">
            <Link href="/book" className={buttonClass("quiet", "px-3")}>Book</Link>
            <Link href="/login" className={buttonClass("secondary", "px-4")}>Sign in</Link>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={cx("mx-auto w-full flex-1 px-4 py-10 sm:px-8 lg:py-14", narrow ? "max-w-xl" : "max-w-5xl")}>{children}</main>
      <footer className="mx-auto w-full max-w-5xl px-4 pb-8 sm:px-8"><EmergencyNotice text={crisis} /></footer>
    </div>
  );
}
