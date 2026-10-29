import { SITE } from "@/lib/site";
import { JsonLd } from "@/components/site/json-ld";
import { breadcrumbSchema, pageMeta } from "@/lib/seo";
import { SiteShell } from "@/components/site/site-shell";
import { CtaBand, PageIntro, Portrait } from "@/components/site/parts";
import { LinkButton } from "@/components/ui/button";

export const metadata = pageMeta("/about", "About your psychologist in Randburg, Johannesburg", "Meet a registered clinical psychologist working with adults in Randburg, Johannesburg and Sandton, and learn how trauma-informed therapy here works.");

const CONTAINER = "mx-auto max-w-6xl px-4 sm:px-8";

const VALUES = [
  { title: "Safety before depth", text: "We never go further than you are ready to. Stopping, slowing down and changing direction are always allowed." },
  { title: "You are the expert on you", text: "I bring training and perspective; you bring the knowledge of your own life. The work is shared." },
  { title: "Your whole context", text: "Culture, family, community and history are part of who you are, so they are part of the work." },
  { title: "Change you can feel", text: "Insight matters, but so does what changes on a Tuesday afternoon. We keep one eye on daily life." },
];

const FIRST_STEPS = [
  { title: "A short conversation", text: "Tell me what brought you here and what you hope will change. Ask me anything." },
  { title: "A plan that fits", text: "We agree how often to meet, what to focus on first and how we will know it is helping." },
  { title: "Your first sessions", text: "We begin gently, building trust and steadiness before anything harder." },
];

export default function About() {
  return (
    <SiteShell>
      <JsonLd data={breadcrumbSchema([{ name: "About", path: "/about" }])} />
      <PageIntro title="Experience rooted in healing."
        aside={<Portrait alt={`${SITE.practitioner}, clinical psychologist`} priority className="mx-auto w-full max-w-sm" />}>
        {SITE.practitioner} is a registered clinical psychologist who works with adults navigating trauma, change and the question of who they are becoming.
      </PageIntro>

      <section className={`${CONTAINER} grid gap-10 py-16 lg:grid-cols-[0.8fr_1.2fr] lg:py-24`}>
        <h2 className="reveal text-3xl sm:text-4xl">Looking back. Moving forward.</h2>
        <div className="reveal max-w-2xl space-y-5 text-lg text-ink-muted">
          <p>Placeholder biography. Introduce yourself here in your own words: how you came to this work, what you have learned from the people you have sat with, and what a client can expect from you.</p>
          <p>Mention your training, years of experience, special interests and the settings you have worked in. Keep it human. Clients are choosing a person, not a CV.</p>
          <p>Close with what you believe about change. A sentence or two that sounds like you will do more than any list of qualifications.</p>
        </div>
      </section>

      <section className="on-dark bg-sage-900 text-sage-100">
        <div className={`${CONTAINER} py-16 lg:py-24`}>
          <h2 className="reveal max-w-xl text-3xl text-white sm:text-4xl">How I work</h2>
          <dl className="mt-10 grid gap-x-12 gap-y-8 md:grid-cols-2">
            {VALUES.map((v) => (
              <div key={v.title} className="reveal border-t border-gold-400/50 pt-4">
                <dt className="font-display text-xl font-semibold text-white">{v.title}</dt>
                <dd className="mt-2 max-w-md text-sage-300">{v.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className={`${CONTAINER} grid gap-12 py-16 lg:grid-cols-2 lg:py-24`}>
        <div className="reveal">
          <h2 className="text-3xl sm:text-4xl">What to expect at the start.</h2>
          <ol className="mt-8 flex flex-col gap-6">
            {FIRST_STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold-100 font-display font-semibold text-gold-700 ring-1 ring-gold-200">{i + 1}</span>
                <div>
                  <h3>{s.title}</h3>
                  <p className="text-ink-muted">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <LinkButton href="/book" className="mt-8">Book a first session</LinkButton>
        </div>
        <div className="reveal self-start rounded-card bg-sunk p-6 sm:p-8">
          <h2 className="text-xl">Registration and training</h2>
          <dl className="mt-4 divide-y divide-line">
            {[["Registration", SITE.registration], ["Qualifications", "[Degrees and institutions]"], ["Professional bodies", "[Memberships]"], ["Languages", "[Languages offered]"]].map(([k, v]) => (
              <div key={k} className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                <dt className="font-medium text-sage-900">{k}</dt>
                <dd className="text-ink-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <CtaBand />
    </SiteShell>
  );
}
