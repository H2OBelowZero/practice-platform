import { requireRole } from "@/lib/auth/session";
import { formatZar } from "@/lib/money";
import { loadPortalPayments } from "@/lib/portal/load";
import { summarise } from "@/lib/portal/payments";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";

export const metadata = { title: "Home" };

// Placeholder: the real portal home (upcoming appointment, documents to complete) arrives in a later task. The "Amount due" card is a read-only summary
// of what is outstanding on the invoices this user may see (RLS); if it cannot be loaded the card is simply left out rather than showing a wrong figure.
export default async function PortalHome() {
  const me = await requireRole(["patient", "guardian"]);
  let due: ReturnType<typeof summarise> | null = null;
  try {
    const sb = await supabaseServer();
    due = summarise((await loadPortalPayments(sb, me.userId, sastDate(new Date()))).list);
  } catch (e) { console.error(e instanceof Error ? e.message : "portal home payments failed"); }

  return (
    <>
      <PageHeader title="Welcome" description="Your appointments, documents and payments will appear here." />
      {due && (
        <Card className="mb-6">
          <h2 className="mb-2">Amount due</h2>
          <p className="text-3xl font-semibold">{formatZar(due.outstandingCents)}</p>
          <p className="mb-4 text-ink-muted">{due.openCount === 0 ? "You have nothing to pay right now." : `On ${due.openCount} open ${due.openCount === 1 ? "invoice" : "invoices"}.`}</p>
          <LinkButton href="/portal/payments" variant={due.outstandingCents > 0 ? "primary" : "secondary"}>{due.outstandingCents > 0 ? "See what you owe" : "View payments"}</LinkButton>
        </Card>
      )}
      <Card>
        <h2 className="mb-2">Need a session?</h2>
        <p className="mb-4 text-ink-muted">Choose a time that suits you.</p>
        <LinkButton href="/book">Book an appointment</LinkButton>
      </Card>
    </>
  );
}
