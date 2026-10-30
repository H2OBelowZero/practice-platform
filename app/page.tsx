import Image from "next/image";
import Link from "next/link";
import { AREAS, SERVICE_AREAS, SITE, STAGES } from "@/lib/site";
import { JsonLd } from "@/components/site/json-ld";
import { pageMeta, practiceSchema, websiteSchema } from "@/lib/seo";
import { SiteShell } from "@/components/site/site-shell";
import { Arcs, CtaBand, Portrait } from "@/components/site/parts";
import { Sprig } from "@/components/shell/ornament";
import { LinkButton } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: "calendar", title: "Choose a time", text: "See the sessions on offer and pick a time that suits you. No account is needed to look." },
  { icon: "doc", title: "Complete your forms", text: "Fill in your intake and consent forms in your own time, before your first visit." },
  { icon: "card", title: "Pay securely", text: "Receive invoices and pay online, or keep a record of other payments." },
];

export const metadata = pageMeta("/", "Psychologist in Randburg & Johannesburg | Trauma-informed therapy", "Trauma-informed psychotherapy for adults in Randburg, Johannesburg, Sandton and across Gauteng. Book online, complete your forms securely and claim from your medical aid.", { title: { absolute: "Psychologist in Randburg & Johannesburg | Trauma-informed therapy" } });

const CONTAINER = "mx-auto max-w-6xl px-4 sm:px-8";

export default function Home() {
  return (
    <SiteShell>
      <JsonLd data={[practiceSchema(), websiteSchema()]} />
      <section className="relative overflow-hidden">
        <Arcs className="absolute -bottom-16 -left-24 w-[38rem] max-w-[95vw] -scale-x-100" />
        <div className={`${CONTAINER} relative grid gap-12 py-12 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:py-24`}>
          <div className="hero-in">
            <p className="mb-4 text-sm font-medium uppercase tracking-[0.18em] text-gold-700">Psychologist in Randburg, Johannesburg &amp; Sandton</p>
            <h1 className="text-[2.5rem] leading-[1.08] sm:text-6xl">
              Look back with care.<br />Live fully now.<br /><span className="text-sage-700">Grow toward what&rsquo;s next.</span>
            </h1>
            <p className="mt-6 max-w-lg text-lg text-ink-muted">
              Thoughtful, trauma-informed psychotherapy for adults in Randburg, Johannesburg, Sandton and across Gauteng, in a calm and private space. Book online, complete your forms and manage your payments in one place.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <LinkButton href="/book">Book an appointment</LinkButton>
              <LinkButton href="/about" variant="secondary">Meet your psychologist</LinkButton>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium text-sage-900">
              {["Confidential", "Trauma-informed", "Culturally responsive"].map((t) => (
                <li key={t} className="flex items-center gap-2"><Icon name="check" className="text-gold-700" />{t}</li>
              ))}
            </ul>
          </div>
          <div className="relative mx-auto w-full max-w-md lg:max-w-none">
            <Portrait alt={`${SITE.practitioner}, clinical psychologist`} priority className="w-full" />
            <figure className="absolute -bottom-6 -left-2 flex max-w-[17rem] items-center gap-3 rounded-card bg-sage-900 px-5 py-4 text-sage-100 shadow-[var(--shadow-lift)] sm:-left-8">
              <Sprig className="text-3xl text-gold-400" />
              <p className="font-script text-2xl leading-tight text-gold-200">Small steps create meaningful change.</p>
            </figure>
          </div>
        </div>
      </section>

      <section className="on-dark bg-sage-900 py-14 text-center lg:py-20">
        <div className={`${CONTAINER} reveal`}>
          <p className="mx-auto max-w-3xl font-script text-4xl leading-tight text-gold-200 sm:text-6xl">Looking back is not going backwards.</p>
          <p className="mx-auto mt-5 max-w-xl text-sage-300">Sometimes the way forward runs through what we left behind. We go there together, carefully, and only as far as you choose.</p>
        </div>
      </section>

      <section className={`${CONTAINER} grid gap-12 py-16 lg:grid-cols-[0.8fr_1.2fr] lg:py-28`}>
        <div className="reveal lg:sticky lg:top-28 lg:self-start">
          <h2 className="text-3xl sm:text-4xl">One story, three tenses.</h2>
          <p className="mt-4 max-w-md text-ink-muted">Healing is not a straight line, but it has a shape. Here is how the work usually unfolds, from understanding to choosing.</p>
          <LinkButton href="/about" variant="secondary" className="mt-6">Discover our approach</LinkButton>
        </div>
        <ol className="thread relative flex flex-col gap-14 pl-12">
          {STAGES.map((s) => (
            <li key={s.title} className="reveal relative">
              <span aria-hidden="true" className="absolute -left-12 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-canvas ring-2 ring-gold-500">
                <span className="h-2 w-2 rounded-full bg-gold-500" />
              </span>
              <h3 className="text-2xl sm:text-3xl">{s.title}</h3>
              <p className="mt-3 max-w-lg text-lg text-ink-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-y border-line/70 bg-surface">
        <div className={`${CONTAINER} py-16 lg:py-24`}>
          <div className="reveal flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-xl">
              <h2 className="text-3xl sm:text-4xl">Therapy that meets you where you are.</h2>
              <p className="mt-4 text-ink-muted">A safe, collaborative and nonjudgmental space to explore what is weighing on you. Start with what feels closest.</p>
            </div>
            <LinkButton href="/practices" variant="secondary" className="shrink-0">Explore psychotherapy</LinkButton>
          </div>
          <ul className="mt-10 grid gap-x-12 md:grid-cols-2">
            {AREAS.map((a) => (
              <li key={a.slug} className="border-t border-line">
                <Link href={`/practices#${a.slug}`} className="group -mx-3 flex items-start justify-between gap-4 rounded-xl px-3 py-6 text-ink no-underline transition-colors duration-200 hover:bg-gold-100/60 hover:text-ink">
                  <span>
                    <span className="block font-display text-xl font-semibold text-sage-900">{a.title}</span>
                    <span className="mt-1 block text-ink-muted">{a.short}</span>
                  </span>
                  <span aria-hidden="true" className="mt-1 text-gold-700 transition-transform duration-300 ease-out group-hover:translate-x-1.5">&rarr;</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="on-dark relative overflow-hidden bg-sage-900 text-sage-100">
        <div className={`${CONTAINER} grid gap-12 py-16 lg:grid-cols-2 lg:items-center lg:py-24`}>
          <div className="reveal overflow-hidden rounded-[1.75rem] shadow-[0_18px_40px_-14px_rgb(0_0_0/0.5)] ring-1 ring-gold-400/40">
            <Image src="/images/therapy-session.webp" alt="A client talking with their psychologist during a therapy session" width={1537} height={1023}
                   sizes="(min-width: 1024px) 34rem, 100vw" className="aspect-[4/3] w-full object-cover object-[45%_50%]" />
          </div>
          <div className="reveal">
            <h2 className="text-3xl text-white sm:text-4xl">A collaborative approach to healing.</h2>
            <p className="mt-4 max-w-lg text-sage-300">Every person arrives with a different story, so the work is shaped around yours. It draws on evidence-based practice and stays flexible as you change.</p>
            <dl className="mt-8 grid gap-6 sm:grid-cols-2">
              <div className="border-t border-gold-400/50 pt-4">
                <dt className="font-display text-lg font-semibold text-white">Trauma-informed</dt>
                <dd className="mt-1 text-sage-300">Safety, choice and pacing come first, so you never have to relive more than you are ready to.</dd>
              </div>
              <div className="border-t border-gold-400/50 pt-4">
                <dt className="font-display text-lg font-semibold text-white">Culturally responsive</dt>
                <dd className="mt-1 text-sage-300">Your background, language and beliefs are part of the work, not something to work around.</dd>
              </div>
            </dl>
            <LinkButton href="/practices" variant="secondary" className="mt-8">Explore our practice</LinkButton>
          </div>
        </div>
      </section>

      <section className={`${CONTAINER} py-16 lg:py-24`}>
        <div className="reveal grid gap-10 rounded-card bg-sunk p-6 sm:p-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <div>
            <h2 className="text-3xl">A calm, simple way to book your session.</h2>
            <p className="mt-3 max-w-md text-ink-muted">Already a client? Your appointments, forms and payments are waiting in your private portal.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <LinkButton href="/book">Book an appointment</LinkButton>
              <LinkButton href="/login" variant="secondary">Sign in to your portal</LinkButton>
            </div>
          </div>
          <ol className="flex flex-col gap-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold-100 text-lg text-gold-700 ring-1 ring-gold-200"><Icon name={s.icon} /></span>
                <div>
                  <h3><span className="sr-only">Step {i + 1}: </span>{s.title}</h3>
                  <p className="text-ink-muted">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className={`${CONTAINER} pb-16 lg:pb-24`}>
        <div className="reveal max-w-3xl">
          <h2 className="text-3xl sm:text-4xl">Psychotherapy in Randburg, Johannesburg, Sandton and across Gauteng.</h2>
          <p className="mt-4 text-lg text-ink-muted">Clients come to us from {SERVICE_AREAS.slice(0, -1).join(", ")} and {SERVICE_AREAS[SERVICE_AREAS.length - 1]}, and from across Gauteng. Many can claim from their medical aid. Fees and claiming are explained before you book.</p>
          <LinkButton href="/contact" variant="secondary" className="mt-6">Find the rooms in Randburg</LinkButton>
        </div>
      </section>

      <CtaBand note="We see you." title="Your life. Your journey." text="Take the next step in your healing and self-discovery." />
    </SiteShell>
  );
}
