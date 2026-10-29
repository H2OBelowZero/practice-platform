import { SiteShell } from "@/components/site/site-shell";

export const metadata = { robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <SiteShell narrow>{children}</SiteShell>;
}
