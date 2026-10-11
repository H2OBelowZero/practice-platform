import Link from "next/link";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { cleanSearch } from "@/lib/patients/search";
import { realDateParam } from "@/lib/booking/input";
import { durationLabel, formatLabel } from "@/lib/booking/labels";
import { formatZar } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { ActionForm } from "@/components/ui/action-form";
import { Button, LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { createAppointment } from "../actions";

export const metadata = { title: "New appointment" };

type PatientRow = { id: string; first_name: string; last_name: string; status: string };

/** Staff book an appointment for a patient: find the patient (names only, through the staff user's own RLS), pick a session and any time. */
export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<{ patient?: string; q?: string; date?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const patientId = z.uuid().safeParse(sp.patient).data;

  let patient: PatientRow | null = null;
  if (patientId) {
    const { data } = await sb.from("patients").select("id, first_name, last_name, status").eq("id", patientId).maybeSingle();
    patient = (data as PatientRow | null) ?? null;
  }

  // ---- step 1: choose the patient --------------------------------------------------------------------------------------------
  if (!patient) {
    const q = cleanSearch(sp.q ?? "");
    let results: PatientRow[] = [];
    let failed = false;
    if (q) {
      const words = q.toLowerCase().split(" ");
      // one OR filter on the first word in the database; the other words narrow the (small) result here
      const res = await sb.from("patients").select("id, first_name, last_name, status").neq("status", "archived")
        .or(`first_name.ilike.%${words[0]}%,last_name.ilike.%${words[0]}%`).order("last_name").order("first_name").limit(50);
      failed = !!res.error;
      results = ((res.data ?? []) as PatientRow[]).filter((p) => words.every((w) => `${p.first_name} ${p.last_name}`.toLowerCase().includes(w))).slice(0, 20);
    }
    return (
      <>
        <PageHeader title="New appointment" description="First choose the patient." />
        {patientId && <Notice tone="warning">We could not find that patient. Search again.</Notice>}
        <form method="get" role="search" className="mb-8 flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1"><Input id="q" label="Patient name" type="search" defaultValue={q} maxLength={60} required hint="Part of the first or last name." /></div>
          <Button type="submit" variant="secondary" className="mb-5">Search</Button>
        </form>
        {failed && <Notice tone="error">The search failed. Please try again.</Notice>}
        {q && !failed && (results.length === 0
          ? <Notice tone="info">No patients match “{q}”.</Notice>
          : (
            <ul className="m-0 grid list-none gap-2 p-0" aria-label="Matching patients">
              {results.map((p) => (
                <li key={p.id}>
                  <Link href={`/app/calendar/new?patient=${p.id}`} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-ink no-underline hover:bg-sage-100 hover:text-ink">
                    <span className="font-medium">{p.first_name} {p.last_name}</span><span className="text-sm text-ink-muted">Choose</span>
                  </Link>
                </li>
              ))}
            </ul>
          ))}
        <p className="mt-8"><LinkButton href="/app/calendar" variant="quiet">Back to the calendar</LinkButton></p>
      </>
    );
  }

  // ---- step 2: session, time and status --------------------------------------------------------------------------------------
  const { data: types } = await sb.from("session_types").select("id, name, duration_min, fee_cents, format").eq("active", true).order("name");
  const date = realDateParam(sp.date) ?? sastDate(new Date());
  return (
    <>
      <PageHeader title="New appointment" description={<>For <strong className="text-ink">{patient.first_name} {patient.last_name}</strong>. <Link href="/app/calendar/new">Choose a different patient</Link>.</>} />
      {patient.status === "archived" && <Notice tone="warning">This patient is archived.</Notice>}
      {(types ?? []).length === 0 ? <Notice tone="warning">There are no active session types. Add one in Settings first.</Notice> : (
        <Card className="max-w-2xl">
          <ActionForm action={createAppointment} args={[]} submitLabel="Book appointment" pendingLabel="Booking…">
            <input type="hidden" name="patientId" value={patient.id} />
            <Select id="typeId" label="Session type" required>
              {(types ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} · {durationLabel(t.duration_min)} · {formatLabel(t.format)} · {formatZar(t.fee_cents)}</option>)}
            </Select>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <Input id="date" label="Date" type="date" required defaultValue={date} />
              <Input id="time" label="Time (SAST)" type="time" step={300} required defaultValue="09:00" />
            </div>
            <Select id="status" label="Status" defaultValue="confirmed" hint="Confirmed holds the time and emails the patient. Requested holds the time until you confirm it.">
              <option value="confirmed">Confirmed</option>
              <option value="tentative">Requested</option>
            </Select>
            <p className="mb-5 text-sm text-ink-muted">Staff can book any time, including outside working hours. An overlap with another appointment is refused.</p>
          </ActionForm>
        </Card>
      )}
      <p className="mt-8"><LinkButton href="/app/calendar" variant="quiet">Back to the calendar</LinkButton></p>
    </>
  );
}
