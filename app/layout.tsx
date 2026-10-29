import type { Metadata, Viewport } from "next";
import { Allura, DM_Sans, Montserrat } from "next/font/google";
import "./globals.css";
import { BRAND, BRAND_SHORT, siteUrl } from "@/lib/site";
import { DEFAULT_DESCRIPTION } from "@/lib/seo";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: `Psychologist in Randburg & Johannesburg | ${BRAND_SHORT}`, template: `%s | ${BRAND_SHORT}` },
  description: DEFAULT_DESCRIPTION,
  applicationName: BRAND,
  openGraph: { type: "website", locale: "en_ZA", siteName: BRAND, images: ["/opengraph-image"] },
  twitter: { card: "summary_large_image", images: ["/opengraph-image"] },
  robots: { index: true, follow: true },
  // Regional hints for search engines that still read them.
  other: { "geo.region": "ZA-GT", "geo.placename": "Randburg, Johannesburg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f7f3ea" };

// Every page renders per request: the nonce-based CSP (middleware.ts) only works if Next can stamp this request's nonce on its scripts,
// which a statically prerendered page cannot carry. Cost is negligible for a private practice's traffic.
export const dynamic = "force-dynamic";

// next/font downloads these at build time and serves them from our own origin: no runtime font requests (CSP font-src 'self').
const body = DM_Sans({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const heading = Montserrat({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-heading", display: "swap" });
const flourish = Allura({ subsets: ["latin"], weight: "400", variable: "--font-flourish", display: "swap" });

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-ZA" className={`${body.variable} ${heading.variable} ${flourish.variable}`}>
      <body>{children}</body>
    </html>
  );
}
