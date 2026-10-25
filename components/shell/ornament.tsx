import { cx } from "@/lib/cx";

// Brand marks, all decorative (aria-hidden). Paths that draw themselves carry pathLength="1" for the .draw animation in globals.css.

/** The leaf sprig: one stem, four leaves. */
export function Sprig({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true" focusable="false" className={cx("inline-block shrink-0", className)}>
      <path d="M5 21.5C8.5 16 12.5 10 19.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <g fill="currentColor">
        <path d="M8.2 16.8C5.3 16.9 3.4 15.5 2.6 12.9c2.9-.1 4.8 1.3 5.6 3.9z" />
        <path d="M9 15.6c-.3-2.9 1-5 3.5-6 .3 2.9-1 5-3.5 6z" />
        <path d="M12.6 11.2c-2.6-.6-4-2.4-4.1-5.1 2.6.6 4 2.4 4.1 5.1z" />
        <path d="M13.6 10c.6-2.7 2.5-4.2 5.3-4.4-.6 2.7-2.5 4.2-5.3 4.4z" />
      </g>
    </svg>
  );
}

/** Name in spaced capitals with a gold script line under it. */
export function Wordmark({ name, tagline, dark, className }: { name: string; tagline?: string; dark?: boolean; className?: string }) {
  return (
    <span className={cx("flex items-center gap-2.5", className)}>
      <Sprig className={cx("text-[1.6em] max-[399px]:hidden", dark ? "text-gold-400" : "text-sage-700")} />
      <span className="flex min-w-0 flex-col leading-none">
        <span className={cx("truncate font-display text-[0.95em] font-bold uppercase tracking-[0.06em] sm:tracking-[0.12em]", dark ? "text-white" : "text-sage-900")}>{name}</span>
        {tagline && <span className={cx("mt-1 font-script text-[1.15em] leading-none normal-case", dark ? "text-gold-400" : "text-gold-700")}>{tagline}</span>}
      </span>
    </span>
  );
}

/** Two gold arcs and a faint forest wash that sweep across the foot of the sidebar. */
export function SidebarArcs({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 256 220" preserveAspectRatio="none" aria-hidden="true" focusable="false" className={cx("draw pointer-events-none", className)}>
      <path d="M-10 214C60 196 120 150 160 96S236 18 270 6" pathLength="1" fill="none" stroke="var(--color-gold-400)" strokeWidth="1.2" strokeOpacity="0.85" />
      <path d="M-10 224C70 210 140 170 186 118S250 50 272 40" pathLength="1" fill="none" stroke="var(--color-gold-400)" strokeWidth="0.8" strokeOpacity="0.55" />
      <path className="fill" d="M-10 230C70 214 150 172 196 124S256 64 276 58V240H-10z" fill="var(--color-sage-950)" fillOpacity="0.55" />
    </svg>
  );
}

/** Corner sweeps for the public pages: a forest curve top-left, gold linework bottom-right. Fixed behind the content. */
export function CornerSweeps() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden no-print">
      <svg viewBox="0 0 400 300" className="draw absolute -left-24 -top-24 w-[34rem] max-w-[90vw] sm:-left-16 sm:-top-16">
        <path className="fill" d="M0 0H400C330 40 250 60 170 120S40 260 0 300z" fill="var(--color-sage-900)" fillOpacity="0.95" />
        <path d="M0 312C46 250 96 170 176 126S338 52 414 12" pathLength="1" fill="none" stroke="var(--color-gold-400)" strokeWidth="1.4" />
      </svg>
      <svg viewBox="0 0 400 300" className="draw absolute -bottom-20 -right-20 w-[36rem] max-w-[95vw]">
        <path d="M410 30C340 90 300 170 220 220S70 290 -10 300" pathLength="1" fill="none" stroke="var(--color-gold-400)" strokeWidth="1.2" />
        <path d="M414 70C350 130 310 200 236 246S90 306 20 312" pathLength="1" fill="none" stroke="var(--color-gold-400)" strokeWidth="0.8" strokeOpacity="0.6" />
        <path className="fill" d="M400 110C350 170 320 230 250 270S150 300 120 310H400z" fill="var(--color-sage-900)" fillOpacity="0.9" />
      </svg>
    </div>
  );
}
