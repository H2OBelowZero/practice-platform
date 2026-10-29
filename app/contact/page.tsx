import { SERVICE_AREAS, SITE } from "@/lib/site";
import { JsonLd } from "@/components/site/json-ld";
import { breadcrumbSchema, pageMeta } from "@/lib/seo";
import { SiteShell } from "@/components/site/site-shell";
import { PageIntro, Placeholder } from "@/components/site/parts";
import { buttonClass, LinkButton } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";

export const metadata = pageMeta("/contact", "Contact a psychologist in Randburg, Johannesburg", "Call, email or book online with a psychologist serving Randburg, Johannesburg, Sandton and Gauteng. Find the rooms, hours and what happens after you reach out.");

const CONTAINER = "mx-auto max-w-6xl px-4 sm:px-8";

const NEXT = [
  { title: "We reply within a working day", text: "A short, personal answer, not an automated one." },
  { title: "A brief, no-pressure chat", text: "You tell us what you are looking for; we tell you honestly whether we can help." },
  { title: "Book when you are ready", text: "Choose a session online, or let us help you find a time." },
];

export default function Contact() {
  const ways: { icon: IconName; label: string; value: string; href: string }[] = [
    { icon: "send", label: "Email", value: SITE.email, href: `mailto:${SITE.email}` },
    { icon: "phone", label: "Call", value: SITE.phone, href: SITE.phoneHref },
  ];
  return (
    <SiteShell>
      <JsonLd data={breadcrumbSchema([{ name: "Contact", path: "/contact" }])} />
      <PageIntro title="Take the first step. We will meet you there.">
        Not sure where to start? That is a perfectly good place. Reach out in whichever way feels easiest.
      </PageIntro>

      <section className={`${CONTAINER} grid gap-12 py-16 lg:grid-cols-[1fr_1fr] lg:py-24`}>
        <div className="reveal">
          <ul className="flex flex-col gap-3">
            {ways.map((w) => (
              <li key={w.label}>
                <a href={w.href} className="group flex items-center gap-4 rounded-card border border-line bg-surface p-5 text-ink no-underline transition-[border-color,box-shadow,transform] duration-300 ease-out hover:-translate-y-0.5 hover:border-gold-400 hover:text-ink hover:shadow-[var(--shadow-lift)]">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold-100 text-lg text-gold-700 ring-1 ring-gold-200"><Icon name={w.icon} /></span>
                  <span>
                    <span className="block text-sm text-ink-muted">{w.label}</span>
                    <span className="block font-display text-lg font-semibold text-sage-900">{w.value}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <dl className="mt-8 grid gap-4 sm:grid-cols-2">
            <div><dt className="font-medium text-sage-900">Rooms</dt><dd className="text-ink-muted">{SITE.location}</dd></div>
            <div><dt className="font-medium text-sage-900">Hours</dt><dd className="text-ink-muted">{SITE.hours}</dd></div>
            <div className="sm:col-span-2"><dt className="font-medium text-sage-900">Areas we serve</dt><dd className="text-ink-muted">{SERVICE_AREAS.join(", ")} and the rest of Gauteng.</dd></div>
          </dl>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton href="/book">Book online</LinkButton>
            <a href={`mailto:${SITE.email}?subject=Enquiry`} className={buttonClass("secondary")}>Send an email</a>
          </div>
        </div>
        <Placeholder label="Map or photograph of the practice entrance" className="reveal min-h-72 rounded-card" />
      </section>

      <section className="on-dark bg-sage-900 text-sage-100">
        <div className={`${CONTAINER} py-16 lg:py-20`}>
          <h2 className="reveal text-3xl text-white sm:text-4xl">What happens after you reach out</h2>
          <ol className="mt-10 grid gap-8 md:grid-cols-3">
            {NEXT.map((n, i) => (
              <li key={n.title} className="reveal border-t border-gold-400/50 pt-4">
                <h3 className="text-lg text-white"><span className="sr-only">Step {i + 1}: </span>{n.title}</h3>
                <p className="mt-2 text-sage-300">{n.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </SiteShell>
  );
}
