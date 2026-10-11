import { PublicShell } from "@/components/shell/public-shell";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: "calendar", title: "Choose a time", text: "See the sessions on offer and pick a time that suits you. No account is needed to look." },
  { icon: "doc", title: "Complete your forms", text: "Fill in your intake and consent forms in your own time, before your first visit." },
  { icon: "card", title: "Pay securely", text: "Receive invoices and pay online, or keep a record of other payments." },
];

export default function Home() {
  return (
    <PublicShell>
      <section className="grid gap-10 lg:grid-cols-[1.15fr_1fr] lg:items-center">
        <div>
          <p className="mb-3 text-sm font-semibold uppercase tracking-wider text-sage-700">Private psychology practice</p>
          <h1 className="text-4xl sm:text-5xl">A calm, simple way to book your session.</h1>
          <p className="mt-5 max-w-xl text-lg text-ink-muted">
            Book an appointment online, complete your forms and manage your payments in one private place. Your information stays confidential.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton href="/book">Book an appointment</LinkButton>
            <LinkButton href="/login" variant="secondary">Sign in to your portal</LinkButton>
          </div>
        </div>
        <Card>
          <h2 className="mb-4">How it works</h2>
          <ol className="flex flex-col gap-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-sage-700 text-white"><Icon name={s.icon} /></span>
                <div>
                  <h3><span className="sr-only">Step {i + 1}: </span>{s.title}</h3>
                  <p className="text-ink-muted">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </section>
    </PublicShell>
  );
}
