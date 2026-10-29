import Link from "next/link";
import { cx } from "@/lib/cx";
import { BRAND_SHORT, BRAND_TAGLINE, NAV, SITE } from "@/lib/site";
import { getCrisisText } from "@/lib/practice";
import { SkipLink } from "@/components/ui/skip-link";
import { EmergencyNotice } from "@/components/ui/emergency-notice";
import { Wordmark } from "@/components/shell/ornament";
import { SiteHeader } from "./site-header";

const FOOT_LINK = "text-sage-300 no-underline hover:text-white";

/** Shell for the public marketing pages and the sign-in flow. Pages own their sections (full-bleed bands); `narrow` gives single-column forms a centred column. */
export async function SiteShell({ children, narrow }: { children: React.ReactNode; narrow?: boolean }) {
  const crisis = await getCrisisText();
  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <SiteHeader />
      <main id="main" tabIndex={-1} className={cx("flex-1", narrow && "page-enter mx-auto w-full max-w-xl px-4 py-10 sm:px-8 lg:py-14")}>{children}</main>
      <div className="mx-auto w-full max-w-6xl px-4 pb-8 pt-10 sm:px-8"><EmergencyNotice text={crisis} /></div>
      <footer className="on-dark bg-sage-950 text-sage-300">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <Wordmark name={BRAND_SHORT} tagline={BRAND_TAGLINE} dark className="text-base" />
            <p className="mt-4 max-w-xs text-[0.95rem]">Thoughtful, trauma-informed psychotherapy in a calm, private space.</p>
          </div>
          <nav aria-label="Footer">
            <h2 className="mb-3 text-base text-white">Explore</h2>
            <ul className="flex flex-col gap-2">
              {NAV.map((n) => <li key={n.href}><Link href={n.href} className={FOOT_LINK}>{n.label}</Link></li>)}
              <li><Link href="/book" className={FOOT_LINK}>Book an appointment</Link></li>
              <li><Link href="/login" className={FOOT_LINK}>Client portal</Link></li>
            </ul>
          </nav>
          <div>
            <h2 className="mb-3 text-base text-white">Get in touch</h2>
            <ul className="flex flex-col gap-2">
              <li><a href={SITE.phoneHref} className={FOOT_LINK}>{SITE.phone}</a></li>
              <li><a href={`mailto:${SITE.email}`} className={FOOT_LINK}>{SITE.email}</a></li>
              <li>{SITE.location}</li>
            </ul>
          </div>
        </div>
        <div className="border-t border-white/10">
          <p className="mx-auto max-w-6xl px-4 py-5 text-sm text-sage-300 sm:px-8">{SITE.registration}</p>
        </div>
      </footer>
    </div>
  );
}
