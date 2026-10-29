"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cx } from "@/lib/cx";
import { BRAND_SHORT, BRAND_TAGLINE, NAV } from "@/lib/site";
import { buttonClass } from "@/components/ui/button";
import { Wordmark } from "@/components/shell/ornament";

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(href + "/"));

/** Sticky header: five page links, the client portal and a Book action. Below lg the links fold into a menu that closes on navigation and Escape. */
export function SiteHeader() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const link = (href: string, label: string, mobile?: boolean) => (
    <Link key={href} href={href} aria-current={isActive(path, href) ? "page" : undefined}
          className={cx("group relative text-[0.95rem] font-medium no-underline transition-colors duration-200",
            isActive(path, href) ? "text-sage-900" : "text-ink-muted hover:text-sage-900",
            mobile ? "block rounded-xl px-3 py-3 text-lg hover:bg-sage-100 aria-[current=page]:bg-gold-100" : "px-1 py-2")}>
      {label}
      {!mobile && <span aria-hidden="true" className={cx("absolute inset-x-1 -bottom-0.5 h-0.5 origin-left rounded bg-gold-500 transition-transform duration-300 ease-out",
        isActive(path, href) ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100")} />}
    </Link>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-canvas/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
        <Link href="/" className="min-w-0 text-[0.8rem] no-underline sm:text-base"><Wordmark name={BRAND_SHORT} tagline={BRAND_TAGLINE} /></Link>
        <nav aria-label="Main" className="hidden items-center gap-7 lg:flex">{NAV.map((n) => link(n.href, n.label))}</nav>
        <div className="flex items-center gap-2">
          {/* Wrapped, not `hidden` on the link: buttonClass sets inline-flex, which wins over a bare `hidden`. */}
          <span className="hidden sm:block"><Link href="/login" className={buttonClass("secondary", "px-4")}>Client portal</Link></span>
          <Link href="/book" className={buttonClass("primary", "px-4")}>Book</Link>
          <span className="lg:hidden">
            <button type="button" aria-expanded={open} aria-controls="site-menu" onClick={() => setOpen((o) => !o)} className={buttonClass("quiet", "px-3")}>
              <svg viewBox="0 0 16 16" width="1.2em" height="1.2em" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d={open ? "M4 4l8 8M12 4l-8 8" : "M2.5 5h11M2.5 11h11"} />
              </svg>
              Menu
            </button>
          </span>
        </div>
      </div>
      {open && (
        <nav id="site-menu" aria-label="Menu" className="page-enter border-t border-line/70 bg-canvas px-4 pb-4 pt-2 sm:px-8 lg:hidden">
          <div className="mx-auto flex max-w-6xl flex-col">
            {NAV.map((n) => link(n.href, n.label, true))}
            <div className="mt-3 sm:hidden"><Link href="/login" className={buttonClass("secondary", "w-full")}>Client portal</Link></div>
          </div>
        </nav>
      )}
    </header>
  );
}
