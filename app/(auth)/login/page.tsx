import { safeNext } from "@/lib/auth/redirect";
import { Arcs } from "@/components/site/parts";
import { Icon, type IconName } from "@/components/ui/icon";
import { Notice } from "../ui";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

const INSIDE: { icon: IconName; text: string }[] = [
  { icon: "calendar", text: "Your appointments, to book, move or cancel" },
  { icon: "doc", text: "Intake and consent forms, completed in your own time" },
  { icon: "card", text: "Invoices and receipts, with secure online payment" },
  { icon: "shield", text: "Everything private, and visible only to you and your psychologist" },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; reset?: string }> }) {
  const { next, error, reset } = await searchParams;
  const safe = safeNext(next, "");
  return (
    // On wide screens the two panels break out of the narrow auth column; on phones they stack with the form first.
    <div className="grid overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow-lift)] lg:-mx-48 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="on-dark relative order-2 overflow-hidden bg-sage-900 p-6 text-sage-100 sm:p-10 lg:order-1 lg:flex lg:flex-col lg:justify-center">
        <Arcs className="absolute -bottom-10 -left-16 w-[28rem] max-w-none -scale-x-100 opacity-70" />
        <div className="relative">
          <p className="font-script text-4xl text-gold-200 sm:text-5xl">Welcome back.</p>
          <p className="mt-3 max-w-xs text-sage-300">Your client portal keeps everything in one calm, private place.</p>
          <ul className="mt-8 flex flex-col gap-4">
            {INSIDE.map((i) => (
              <li key={i.text} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-gold-200"><Icon name={i.icon} /></span>
                <span>{i.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="order-1 p-6 sm:p-10 lg:order-2">
        <h1 className="mb-1">Sign in to your portal</h1>
        <p className="mb-6 text-ink-muted">Use the email address you registered with.</p>
        {reset === "1" && <Notice>Your password was changed. Sign in with your new password.</Notice>}
        {error === "link" && <Notice>That link is invalid or has expired. Request a new one from &quot;Forgotten your password?&quot;.</Notice>}
        <LoginForm next={safe || undefined} />
      </div>
    </div>
  );
}
