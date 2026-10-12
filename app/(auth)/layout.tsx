import { PublicShell } from "@/components/shell/public-shell";

export const metadata = { robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell narrow>{children}</PublicShell>;
}
