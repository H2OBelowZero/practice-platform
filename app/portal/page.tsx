import { requireRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";

export const metadata = { title: "Home" };

// Placeholder: the real portal home (upcoming appointment, documents to complete, balance) arrives in a later task.
export default async function PortalHome() {
  await requireRole(["patient", "guardian"]);
  return (
    <>
      <PageHeader title="Welcome" description="Your appointments, documents and payments will appear here." />
      <Card>
        <h2 className="mb-2">Need a session?</h2>
        <p className="mb-4 text-ink-muted">Choose a time that suits you.</p>
        <LinkButton href="/book">Book an appointment</LinkButton>
      </Card>
    </>
  );
}
