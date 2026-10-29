import Link from "next/link";
import { notFound } from "next/navigation";
import { dateLabel, POST_BODY, POSTS, POSTS_PUBLISHED } from "@/lib/site";
import { JsonLd } from "@/components/site/json-ld";
import { articleSchema, breadcrumbSchema, pageMeta } from "@/lib/seo";
import { SiteShell } from "@/components/site/site-shell";
import { CtaBand, Placeholder } from "@/components/site/parts";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params) {
  const { slug } = await params;
  const post = POSTS.find((p) => p.slug === slug);
  // noindex until the placeholder body is replaced (POSTS_PUBLISHED), so thin duplicate pages stay out of Google.
  return post ? pageMeta(`/blog/${post.slug}`, post.title, post.excerpt, { robots: { index: POSTS_PUBLISHED, follow: true } }) : {};
}

export default async function Post({ params }: Params) {
  const { slug } = await params;
  const i = POSTS.findIndex((p) => p.slug === slug);
  if (i < 0) notFound();
  const post = POSTS[i];
  const next = POSTS[(i + 1) % POSTS.length];
  return (
    <SiteShell>
      <JsonLd data={[articleSchema(post), breadcrumbSchema([{ name: "Blog", path: "/blog" }, { name: post.title, path: `/blog/${post.slug}` }])]} />
      <article className="mx-auto max-w-3xl px-4 py-12 sm:px-8 lg:py-20">
        <Link href="/blog" className="inline-flex min-h-11 items-center text-sm font-medium">&larr; All articles</Link>
        <header className="hero-in mt-4">
          <p className="text-sm font-medium text-gold-700">{post.category} · {dateLabel(post.date)} · {post.read}</p>
          <h1 className="mt-3 text-4xl leading-[1.1] sm:text-5xl">{post.title}</h1>
          <p className="mt-5 text-xl text-ink-muted">{post.excerpt}</p>
        </header>
        <Placeholder label="Article cover image" className="mt-10 aspect-[16/9] rounded-card" />
        <div className="mt-10 max-w-prose space-y-5 text-lg">{POST_BODY.map((t) => <p key={t}>{t}</p>)}</div>
        <Link href={`/blog/${next.slug}`} className="group mt-14 block rounded-card border border-line bg-surface p-6 text-ink no-underline transition-[border-color,box-shadow] duration-300 hover:border-gold-400 hover:text-ink hover:shadow-[var(--shadow-lift)]">
          <span className="text-sm text-ink-muted">Read next</span>
          <span className="mt-1 flex items-center justify-between gap-4 font-display text-xl font-semibold text-sage-900">
            {next.title}
            <span aria-hidden="true" className="text-gold-700 transition-transform duration-300 group-hover:translate-x-1.5">&rarr;</span>
          </span>
        </Link>
      </article>
      <CtaBand />
    </SiteShell>
  );
}
