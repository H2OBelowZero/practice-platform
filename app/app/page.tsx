import { requireRole } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";

export const metadata = { title: "Dashboard" };

// Placeholder: the real dashboard (today's sessions, tasks, balances) arrives in a later task.
export default async function StaffHome() {
  await requireRole(["psychologist", "admin", "bookkeeper", "associate"]);
  return (
    <>
      <PageHeader title="Dashboard" description="Today's sessions, tasks and balances will appear here." />
      <Card><p className="text-ink-muted">Nothing to show yet.</p></Card>
    </>
  );
}
