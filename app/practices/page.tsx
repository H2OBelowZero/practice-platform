import { AREAS, FAQ } from "@/lib/site";
import { SiteShell } from "@/components/site/site-shell";
import { CtaBand, PageIntro } from "@/components/site/parts";
import { LinkButton } from "@/components/ui/button";
import { JsonLd } from "@/components/site/json-ld";
import { breadcrumbSchema, faqSchema, pageMeta } from "@/lib/seo";

export const metadata = pageMeta("/practices", "Trauma, anxiety and relationship therapy in Johannesburg", "Therapy for trauma, anxiety, relationships, identity and life transitions in Johannesburg, Sandton and Gauteng. How sessions work, medical aid and common questions.");

const CONTAINER = "mx-auto max-w-6xl px-4 sm:px-8";

export default function Practices() {
  return (
    <SiteShell>
      <JsonLd data={[breadcrumbSchema([{ name: "Practices", path: "/practices" }]), faqSchema()]} />
      <PageIntro title="Therapy that meets you where you are.">
        A safe, collaborative and nonjudgmental space, shaped around you. Find what feels closest below, or book and we will work it out together.
      </PageIntro>

      <section className={`${CONTAINER} grid gap-12 py-16 lg:grid-cols-[16rem_1fr] lg:py-24`}>
        <nav aria-label="Areas of practice" className="lg:sticky lg:top-28 lg:self-start">
          <h2 className="mb-3 text-base">On this page</h2>
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-0">
            {[...AREAS.map((a) => ({ href: `#${a.slug}`, label: a.title })), { href: "#faq", label: "Common questions" }].map((l) => (
              <li key={l.href}>
                <a href={l.href} className="block rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink no-underline transition-colors hover:border-gold-400 hover:bg-gold-100/60 hover:text-ink lg:border-transparent lg:bg-transparent lg:py-2.5">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div>
          <div className="flex flex-col">
            {AREAS.map((a) => (
              <article key={a.slug} id={a.slug} className="reveal scroll-mt-28 border-t border-line py-9 first:border-t-0 first:pt-0">
                <h2 className="text-2xl sm:text-3xl">{a.title}</h2>
                <p className="mt-3 max-w-xl text-lg text-ink-muted">{a.long}</p>
              </article>
            ))}
          </div>

          <div className="reveal mt-6 rounded-card bg-sage-900 p-6 text-sage-100 sm:p-8">
            <h2 className="text-2xl text-white">How sessions work</h2>
            <p className="mt-3 max-w-xl text-sage-300">Session types, lengths, formats and fees are listed on the booking page, so you see exactly what you are choosing before you commit. No account is needed to look.</p>
            <LinkButton href="/book" variant="secondary" className="mt-5">See sessions and times</LinkButton>
          </div>
        </div>
      </section>

      <section id="faq" className="scroll-mt-20 border-y border-line/70 bg-surface">
        <div className={`${CONTAINER} grid gap-10 py-16 lg:grid-cols-[0.8fr_1.2fr] lg:py-24`}>
          <h2 className="reveal text-3xl sm:text-4xl">Common questions</h2>
          <div className="reveal max-w-2xl divide-y divide-line border-y border-line">
            {FAQ.map((f) => (
              <details key={f.q} className="group py-5">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-display text-lg font-semibold text-sage-900 [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span aria-hidden="true" className="text-2xl leading-none text-gold-700 transition-transform duration-300 group-open:rotate-45">+</span>
                </summary>
                <p className="mt-2 max-w-xl text-ink-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <CtaBand />
    </SiteShell>
  );
}
