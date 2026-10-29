import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Sprig } from "@/components/shell/ornament";
import { LinkButton } from "@/components/ui/button";

/** Stand-in for a photograph. Replace the element with next/image once real pictures exist; `label` says what should go there. */
export function Placeholder({ label, className }: { label: string; className?: string }) {
  return (
    <div role="img" aria-label={`Placeholder: ${label}`}
         className={cx("relative flex flex-col items-center justify-center gap-3 overflow-hidden bg-sage-200 p-6 text-center text-sage-900", className)}>
      <Sprig className="text-6xl text-sage-500" />
      <span className="max-w-[16rem] text-sm font-medium">{label}</span>
      <span aria-hidden="true" className="absolute inset-3 rounded-[inherit] border border-dashed border-sage-500/60" />
    </div>
  );
}

/** Gold linework that draws itself once on load (the .draw animation in globals.css). */
export function Arcs({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 400 300" aria-hidden="true" focusable="false" className={cx("draw pointer-events-none", className)}>
      <path d="M410 30C340 90 300 170 220 220S70 290 -10 300" pathLength="1" fill="none" stroke="var(--color-gold-400)" strokeWidth="1.2" />
      <path d="M414 70C350 130 310 200 236 246S90 306 20 312" pathLength="1" fill="none" stroke="var(--color-gold-400)" strokeWidth="0.8" strokeOpacity="0.6" />
    </svg>
  );
}

/** Page opener for the inner pages: a title and one line on ivory, linework behind. */
export function PageIntro({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="relative overflow-hidden border-b border-line/70">
      <Arcs className="absolute -bottom-24 -right-16 w-[34rem] max-w-[90vw] opacity-80" />
      <div className={cx("relative mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-8 lg:py-20", !!aside && "lg:grid-cols-[1.2fr_0.8fr] lg:items-center")}>
        <div className="hero-in">
          <h1 className="max-w-3xl text-4xl leading-[1.1] sm:text-5xl">{title}</h1>
          <p className="mt-5 max-w-xl text-lg text-ink-muted">{children}</p>
        </div>
        {aside}
      </div>
    </section>
  );
}

/** Forest band that closes a page with one clear action. */
export function CtaBand({ title = "You don’t have to do this alone.", text = "Take the next step in your healing. A first conversation costs you nothing but a few minutes.", note = "Your life. Your journey." }: { title?: string; text?: string; note?: string }) {
  return (
    <section className="on-dark relative overflow-hidden bg-sage-900 text-sage-100">
      <Arcs className="absolute -bottom-20 -left-24 w-[34rem] max-w-[90vw] -scale-x-100" />
      <div className="reveal relative mx-auto max-w-6xl px-4 py-16 text-center sm:px-8 lg:py-24">
        <p className="font-script text-4xl text-gold-200 sm:text-5xl">{note}</p>
        <h2 className="mx-auto mt-4 max-w-2xl text-3xl text-white sm:text-4xl">{title}</h2>
        <p className="mx-auto mt-4 max-w-lg text-sage-300">{text}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <LinkButton href="/book" variant="secondary">Book an appointment</LinkButton>
          <Link href="/contact" className="inline-flex min-h-11 items-center px-3 font-medium text-gold-200 underline underline-offset-4 hover:text-white">Or get in touch first</Link>
        </div>
      </div>
    </section>
  );
}
