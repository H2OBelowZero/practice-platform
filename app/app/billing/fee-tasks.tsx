import type { FeeTaskItem } from "@/lib/billing/fee-tasks";
import { LinkButton } from "@/components/ui/button";

/** Late cancellation fees waiting to be invoiced (open late_cancel_fee tasks), each with the link to the invoice form for that task. */
export function FeeTasksList({ items, headingId }: { items: FeeTaskItem[]; headingId: string }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="mb-8 rounded-card border border-line bg-surface p-5 shadow-card">
      <h2 id={headingId} className="mb-1 text-lg">Fees waiting to be invoiced</h2>
      <p className="mb-3 text-ink-muted">These cancellations were marked to charge the late cancellation fee. Creating the invoice closes the task.</p>
      <ul className="m-0 grid list-none gap-2 p-0">
        {items.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-3">
            <span>{i.text}</span>
            <LinkButton href={i.href} variant="secondary">Create fee invoice</LinkButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
