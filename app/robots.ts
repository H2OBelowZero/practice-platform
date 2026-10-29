import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

// Authenticated areas are also noindex via metadata; this stops well-behaved crawlers requesting them at all.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/book"], disallow: ["/app", "/portal", "/api", "/auth", "/login", "/register", "/mfa", "/recover", "/book/confirmed"] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
