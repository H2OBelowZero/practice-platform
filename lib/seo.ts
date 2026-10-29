import type { Metadata } from "next";
import { AREAS, BRAND, FAQ, isReal, SERVICE_AREAS, SITE, siteUrl, type Post } from "@/lib/site";

export const DEFAULT_DESCRIPTION =
  "Trauma-informed psychotherapy for adults in Johannesburg, Sandton and across Gauteng. Book online, complete your forms securely and claim from your medical aid.";

/** Per-page metadata: canonical URL, social cards and a Johannesburg/Gauteng-aware title. `path` is the route ("/about"). */
export function pageMeta(path: string, title: string, description: string, extra: Metadata = {}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", locale: "en_ZA", siteName: BRAND, title, description, url: path, images: ["/opengraph-image"] },
    twitter: { card: "summary_large_image", title, description, images: ["/opengraph-image"] },
    ...extra,
  };
}

const abs = (path: string) => `${siteUrl()}${path}`;

/** Practice as a schema.org local business. Contact fields are emitted only once SITE holds real details, never placeholders. */
export function practiceSchema() {
  const url = siteUrl();
  return {
    "@context": "https://schema.org",
    "@type": ["MedicalBusiness", "ProfessionalService"],
    "@id": `${url}/#practice`,
    name: BRAND,
    url,
    description: DEFAULT_DESCRIPTION,
    image: abs("/opengraph-image"),
    address: {
      "@type": "PostalAddress",
      ...(isReal(SITE.location) && { addressLocality: SITE.location }),
      addressRegion: "Gauteng",
      addressCountry: "ZA",
    },
    areaServed: [
      { "@type": "AdministrativeArea", name: "Gauteng" },
      ...SERVICE_AREAS.map((name) => ({ "@type": "City", name })),
    ],
    knowsAbout: AREAS.map((a) => a.title),
    availableLanguage: "en",
    ...(isReal(SITE.phone) && { telephone: SITE.phone }),
    ...(isReal(SITE.email) && { email: SITE.email }),
    ...(isReal(SITE.practitioner) && { founder: { "@type": "Person", name: SITE.practitioner, jobTitle: "Clinical Psychologist" } }),
  };
}

export const websiteSchema = () => ({
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${siteUrl()}/#website`,
  name: BRAND,
  url: siteUrl(),
  inLanguage: "en-ZA",
  publisher: { "@id": `${siteUrl()}/#practice` },
});

export const faqSchema = () => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
});

export const breadcrumbSchema = (trail: { name: string; path: string }[]) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [{ name: "Home", path: "/" }, ...trail].map((t, i) => ({ "@type": "ListItem", position: i + 1, name: t.name, item: abs(t.path) })),
});

export const articleSchema = (post: Post) => ({
  "@context": "https://schema.org",
  "@type": "BlogPosting",
  headline: post.title,
  description: post.excerpt,
  datePublished: post.date,
  inLanguage: "en-ZA",
  mainEntityOfPage: abs(`/blog/${post.slug}`),
  image: abs("/opengraph-image"),
  author: isReal(SITE.practitioner) ? { "@type": "Person", name: SITE.practitioner } : { "@id": `${siteUrl()}/#practice` },
  publisher: { "@id": `${siteUrl()}/#practice` },
});
