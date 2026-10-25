import Link from "next/link";
import { cx } from "@/lib/cx";
import { getCrisisText } from "@/lib/practice";
import { SkipLink } from "@/components/ui/skip-link";
import { EmergencyNotice } from "@/components/ui/emergency-notice";
import { buttonClass } from "@/components/ui/button";
import { CornerSweeps, Wordmark } from "@/components/shell/ornament";

/** Shell for public pages (landing, booking): brand, two links, crisis notice in the footer. `narrow` suits single-column forms. */
export async function PublicShell({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  const crisis = await getCrisisText();
  return (
    <div className="relative isolate flex min-h-screen flex-col">
      <CornerSweeps />
      <SkipLink />
      <header className="border-b border-line/70 bg-canvas">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3.5 sm:gap-4 sm:px-8">
          <Link href="/" className="min-w-0 text-[0.8rem] no-underline sm:text-base"><Wordmark name="Practice Platform" tagline="Psychology practice" /></Link>
          <nav aria-label="Main" className="flex shrink-0 items-center gap-1">
            <Link href="/book" className={buttonClass("quiet", "px-2 sm:px-3")}>Book</Link>
            <Link href="/login" className={buttonClass("secondary", "px-3 sm:px-4")}>Sign in</Link>
          </nav>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={cx("page-enter mx-auto w-full flex-1 px-4 py-10 sm:px-8 lg:py-14", narrow ? "max-w-xl" : "max-w-5xl")}>{children}</main>
      <footer className="mx-auto w-full max-w-5xl px-4 pb-8 sm:px-8"><EmergencyNotice text={crisis} /></footer>
    </div>
  );
}
