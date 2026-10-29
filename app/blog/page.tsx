import Link from "next/link";
import { dateLabel, POSTS } from "@/lib/site";
import { JsonLd } from "@/components/site/json-ld";
import { breadcrumbSchema, pageMeta } from "@/lib/seo";
import { SiteShell } from "@/components/site/site-shell";
import { CtaBand, PageIntro, Placeholder } from "@/components/site/parts";

export const metadata = pageMeta("/blog", "Blog: reflections on trauma, anxiety and belonging", "Plain-language writing on trauma, anxiety, relationships and belonging from a Johannesburg psychology practice.");

const CONTAINER = "mx-auto max-w-6xl px-4 sm:px-8";

export default function Blog() {
  const [lead, ...rest] = POSTS;
  return (
    <SiteShell>
      <JsonLd data={breadcrumbSchema([{ name: "Blog", path: "/blog" }])} />
      <PageIntro title="Reflections on healing.">Short, plain-language writing on trauma, relationships, belonging and the everyday work of change.</PageIntro>

      <section className={`${CONTAINER} py-16 lg:py-24`}>
        <Link href={`/blog/${lead.slug}`} className="reveal group grid gap-8 text-ink no-underline hover:text-ink lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <Placeholder label="Featured article image" className="aspect-[16/10] rounded-card transition-transform duration-500 ease-out group-hover:scale-[1.015]" />
          <div>
            <p className="text-sm font-medium text-gold-700">{lead.category} · {dateLabel(lead.date)} · {lead.read}</p>
            <h2 className="mt-3 text-3xl underline decoration-transparent decoration-2 underline-offset-8 transition-colors duration-300 group-hover:decoration-gold-500 sm:text-4xl">{lead.title}</h2>
            <p className="mt-4 text-lg text-ink-muted">{lead.excerpt}</p>
          </div>
        </Link>

        <ul className="mt-16 grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
          {rest.map((p) => (
            <li key={p.slug} className="reveal">
              <Link href={`/blog/${p.slug}`} className="group block text-ink no-underline hover:text-ink">
                <Placeholder label="Article image" className="aspect-[4/3] rounded-card transition-transform duration-500 ease-out group-hover:scale-[1.02]" />
                <p className="mt-4 text-sm font-medium text-gold-700">{p.category} · {p.read}</p>
                <h3 className="mt-1 text-xl underline decoration-transparent decoration-2 underline-offset-4 transition-colors duration-300 group-hover:decoration-gold-500">{p.title}</h3>
                <p className="mt-2 text-ink-muted">{p.excerpt}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <CtaBand />
    </SiteShell>
  );
}
