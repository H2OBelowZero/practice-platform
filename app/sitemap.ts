import type { MetadataRoute } from "next";
import { POSTS, POSTS_PUBLISHED, siteUrl } from "@/lib/site";

// Public, indexable pages only. Blog posts join once real articles replace the placeholder body (POSTS_PUBLISHED).
export default function sitemap(): MetadataRoute.Sitemap {
  const url = siteUrl();
  const pages = [
    { path: "", priority: 1, changeFrequency: "monthly" as const },
    { path: "/practices", priority: 0.9, changeFrequency: "monthly" as const },
    { path: "/book", priority: 0.9, changeFrequency: "monthly" as const },
    { path: "/about", priority: 0.8, changeFrequency: "yearly" as const },
    { path: "/contact", priority: 0.8, changeFrequency: "yearly" as const },
    { path: "/blog", priority: 0.6, changeFrequency: "weekly" as const },
  ];
  const posts = POSTS_PUBLISHED ? POSTS.map((p) => ({ path: `/blog/${p.slug}`, priority: 0.5, changeFrequency: "yearly" as const, lastModified: new Date(p.date) })) : [];
  return [...pages, ...posts].map(({ path, ...rest }) => ({ url: `${url}${path}`, ...rest }));
}
