import { notFound } from "next/navigation";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { durationLabel, formatLabel } from "@/lib/booking/labels";
import { formatZar } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDateLabel, sastTime } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";

export const metadata = { title: "Booking received" };

type Row = {
  starts_at: string; status: string;
  session_types: { name: string; duration_min: number; format: string; fee_cents: number } | null;
};

/** Shown right after booking. The crisis text is in the shell footer (practices.crisis_text for signed-in users). The appointment is read with the signed-in user's own client, so RLS only returns their own. */
export default async function ConfirmedPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  await requireRole(["patient", "guardian"]);
  const id = z.uuid().safeParse((await searchParams).id);
  if (!id.success) notFound();

  const sb = await supabaseServer();
  const { data } = await sb.from("appointments")
    .select("starts_at, status, session_types(name, duration_min, format, fee_cents)").eq("id", id.data).maybeSingle();
  const appt = data as unknown as Row | null;
  if (!appt?.session_types) notFound();
  const t = appt.session_types;
  const requested = appt.status === "tentative" || appt.status === "requested";

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={requested ? "Booking requested" : "Booking confirmed"}
        description={requested ? "Thank you. The practice will review your request and let you know." : "Thank you. Your appointment is booked."} />
      <Card className="mb-6">
        <div className="mb-5">
          <StatusChip status={appt.status} label={requested ? "Request received: the practice will confirm" : undefined} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-muted">Session</dt><dd className="font-medium">{t.name}</dd>
          <dt className="text-ink-muted">Date</dt><dd className="font-medium">{sastDateLabel(appt.starts_at)}</dd>
          <dt className="text-ink-muted">Time</dt><dd className="font-medium">{sastTime(appt.starts_at)} (SAST)</dd>
          <dt className="text-ink-muted">Duration</dt><dd className="font-medium">{durationLabel(t.duration_min)}</dd>
          <dt className="text-ink-muted">Format</dt><dd className="font-medium">{formatLabel(t.format)}</dd>
          <dt className="text-ink-muted">Fee</dt><dd className="font-medium">{formatZar(t.fee_cents)}</dd>
        </dl>
      </Card>
      <p className="mb-6 text-ink-muted">We will email you a short confirmation. It contains the date, time and a link only.</p>
      <LinkButton href="/portal">Go to your portal</LinkButton>
    </div>
  );
}
