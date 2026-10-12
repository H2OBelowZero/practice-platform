import Link from "next/link";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { cleanSearch } from "@/lib/patients/search";
import { PRIORITIES } from "@/lib/tasks/list";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { ActionForm } from "@/components/ui/action-form";
import { Button, LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { createTask } from "../actions";

export const metadata = { title: "New task" };

type PatientRow = { id: string; first_name: string; last_name: string };

/**
 * Add a task by hand. A patient is optional: search by name first (a plain GET search, so it works without JavaScript), choose one, and the form below
 * is linked to them. The form posts to createTask, which checks the title, the date, the priority and that the patient exists, all over again.
 */
export default async function NewTaskPage({ searchParams }: { searchParams: Promise<{ patient?: string; q?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const sp = await searchParams;
  const sb = await supabaseServer();

  const patientId = z.uuid().safeParse(sp.patient).data;
  let patient: PatientRow | null = null;
  if (patientId) {
    const { data } = await sb.from("patients").select("id, first_name, last_name").eq("id", patientId).maybeSingle();
    patient = (data as PatientRow | null) ?? null;
  }

  const q = cleanSearch(sp.q ?? "");
  let results: PatientRow[] = [];
  let failed = false;
  if (q && !patient) {
    const words = q.toLowerCase().split(" ");
    const res = await sb.from("patients").select("id, first_name, last_name").neq("status", "archived")
      .or(`first_name.ilike.%${words[0]}%,last_name.ilike.%${words[0]}%`).order("last_name").order("first_name").limit(50);
    failed = !!res.error;
    results = ((res.data ?? []) as PatientRow[]).filter((p) => words.every((w) => `${p.first_name} ${p.last_name}`.toLowerCase().includes(w))).slice(0, 10);
  }
  const keepQ = q ? `&q=${encodeURIComponent(q)}` : "";

  return (
    <>
      <PageHeader title="New task" description="A reminder for you or your colleague. Keep it short, and leave clinical details out: tasks are visible to the psychologist and the admin." />

      <section aria-labelledby="patient-h" className="mb-8">
        <h2 id="patient-h" className="mb-2 text-lg">About a patient (optional)</h2>
        {patient ? (
          <p>This task is about <strong>{patient.first_name} {patient.last_name}</strong>. <Link href={q ? `/app/tasks/new?q=${encodeURIComponent(q)}` : "/app/tasks/new"}>Remove the patient</Link>.</p>
        ) : (
          <>
            <form method="get" role="search" aria-label="Find a patient" className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1"><Input id="q" label="Patient name" type="search" defaultValue={q} maxLength={60} hint="Part of the first or last name. Skip this for a task that is not about one patient." /></div>
              <Button type="submit" variant="secondary" className="mb-5">Search</Button>
            </form>
            {failed && <Notice tone="error">The search failed. Please try again.</Notice>}
            {q && !failed && (results.length === 0
              ? <Notice tone="info">No patients match “{q}”.</Notice>
              : (
                <ul className="m-0 grid list-none gap-2 p-0" aria-label="Matching patients">
                  {results.map((p) => (
                    <li key={p.id}>
                      <Link href={`/app/tasks/new?patient=${p.id}${keepQ}`} className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-ink no-underline hover:bg-sage-100 hover:text-ink">
                        <span className="font-medium">{p.first_name} {p.last_name}</span><span className="text-sm text-ink-muted">Choose</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ))}
          </>
        )}
      </section>

      <Card>
        <ActionForm action={createTask} submitLabel="Add task" pendingLabel="Adding…" args={[]}>
          {patient && <input type="hidden" name="patientId" value={patient.id} />}
          <Input id="title" label="What needs doing" required maxLength={200} hint="Up to 200 characters." autoComplete="off" />
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Input id="due" label="Due date (optional)" type="date" min={sastDate(new Date())} />
            <Select id="priority" label="Priority" defaultValue="normal">{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
          </div>
        </ActionForm>
      </Card>
      <p className="mt-6"><LinkButton href="/app/tasks" variant="quiet">Back to tasks</LinkButton></p>
    </>
  );
}
