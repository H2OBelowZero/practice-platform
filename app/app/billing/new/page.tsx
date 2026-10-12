import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireRole } from "@/lib/auth/session";
import { defaultDueDate, uuid } from "@/lib/billing/input";
import { getBillingPractice } from "@/lib/billing/practice";
import { formatZar, formatZarInput } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDayShort } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { createInvoice } from "../actions";
import { InvoiceFields, type FieldsInitial } from "../invoice-fields";
import { KeepForm } from "../keep-form";

export const metadata = { title: "New invoice" };

type Start = { patientId: string; appointmentId?: string; taskId?: string; line: { description: string; price: string }; intro: string };
type Stop = { stop: React.ReactNode };

async function liveInvoice(sb: SupabaseClient, appointmentId: string): Promise<string | null> {
  const { data } = await sb.from("invoices").select("id").eq("appointment_id", appointmentId).neq("status", "void").maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * From a late-cancellation fee task (?task=): the appointment is cancelled, the line is the practice's late fee, and creating the invoice
 * closes the task. If the appointment already has a live invoice, go to it.
 */
async function fromTask(sb: SupabaseClient, rawId: string): Promise<Start | Stop> {
  const id = uuid.safeParse(rawId);
  if (!id.success) notFound();
  const { data: t } = await sb.from("tasks").select("id, source, status, patient_id, appointment_id").eq("id", id.data).maybeSingle();
  if (!t || t.source !== "late_cancel_fee" || !t.patient_id || !t.appointment_id) notFound();
  const existing = await liveInvoice(sb, t.appointment_id as string);
  if (existing) redirect(`/app/billing/${existing}?notice=exists`);
  if (t.status !== "open") return { stop: <Notice tone="info">This late cancellation fee has already been dealt with. <Link href={`/app/patients/${t.patient_id}?tab=billing`}>See the patient&apos;s invoices</Link>.</Notice> };
  const { data: a } = await sb.from("appointments").select("starts_at").eq("id", t.appointment_id).maybeSingle();
  if (!a) notFound();
  const practice = await getBillingPractice();
  const fee = practice?.late_cancel_fee_cents ?? 0;
  return {
    patientId: t.patient_id as string, appointmentId: t.appointment_id as string, taskId: t.id as string,
    line: { description: `Late cancellation fee — ${sastDayShort(sastDate(a.starts_at as string), true)}`, price: fee > 0 ? formatZarInput(fee) : "" },
    intro: fee > 0 ? `A late cancellation fee of ${formatZar(fee)} (the practice's current fee) is filled in. Change it if you are charging something else.` : "The practice has no late cancellation fee set, so enter the amount to charge.",
  };
}

/** From an attended appointment (?appointment=): one line, the session type and its date, at the session type's fee. One live invoice per appointment. */
async function fromAppointment(sb: SupabaseClient, rawId: string): Promise<Start | Stop> {
  const id = uuid.safeParse(rawId);
  if (!id.success) notFound();
  const { data: a } = await sb.from("appointments").select("id, patient_id, starts_at, status, session_types(name, fee_cents)").eq("id", id.data).maybeSingle();
  if (!a) notFound();
  const existing = await liveInvoice(sb, a.id as string);
  if (existing) redirect(`/app/billing/${existing}?notice=exists`);
  if (a.status !== "attended") return { stop: <Notice tone="warning">Only an attended appointment can be invoiced. <Link href={`/app/calendar/${a.id}`}>Back to the appointment</Link>.</Notice> };
  const st = (Array.isArray(a.session_types) ? a.session_types[0] : a.session_types) as { name: string; fee_cents: number } | null;
  return {
    patientId: a.patient_id as string, appointmentId: a.id as string,
    line: { description: `${st?.name ?? "Session"} — ${sastDayShort(sastDate(a.starts_at as string), true)}`, price: st ? formatZarInput(st.fee_cents) : "" },
    intro: st ? `The session fee of ${formatZar(st.fee_cents)} is filled in. You can change it or add more lines.` : "Enter the amount to charge.",
  };
}

/** A manual invoice for a patient (?patient=): free line items. */
async function manual(sb: SupabaseClient, rawId: string): Promise<Start> {
  const id = uuid.safeParse(rawId);
  if (!id.success) notFound();
  const { data: p } = await sb.from("patients").select("id").eq("id", id.data).maybeSingle();
  if (!p) notFound();
  return { patientId: p.id as string, line: { description: "", price: "" }, intro: "Add the lines to charge." };
}

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<{ appointment?: string; task?: string; patient?: string }> }) {
  await requireRole(["psychologist", "admin"]);
  const sp = await searchParams;
  const sb = await supabaseServer();

  const start = sp.task ? await fromTask(sb, sp.task) : sp.appointment ? await fromAppointment(sb, sp.appointment) : sp.patient ? await manual(sb, sp.patient) : null;
  if (!start) {
    return (
      <>
        <PageHeader title="New invoice" />
        <Notice tone="info">Start from an attended appointment (the Create invoice button), from a late cancellation task, or from a patient&apos;s Billing tab.</Notice>
        <LinkButton href="/app/patients" variant="secondary">Find a patient</LinkButton>
      </>
    );
  }
  if ("stop" in start) return (<><PageHeader title="New invoice" />{start.stop}</>);

  const { data: pat } = await sb.from("patients").select("first_name, last_name").eq("id", start.patientId).maybeSingle();
  const today = sastDate(new Date());
  const initial: FieldsInitial = { lines: [{ description: start.line.description, quantity: "1", price: start.line.price }], discount: "", dueDate: defaultDueDate(today), payer: "self", scheme: "" };
  const practice = await getBillingPractice();

  return (
    <>
      <PageHeader title="New invoice" description={<>For <Link href={`/app/patients/${start.patientId}`}>{pat ? `${pat.first_name} ${pat.last_name}` : "this patient"}</Link>. {start.intro}</>} />
      {practice?.vat_registered && <Notice tone="info" title="VAT">Prices are entered without VAT. {practice.vat_rate}% VAT is added to the total when you save.</Notice>}
      <Card>
        <KeepForm action={createInvoice} args={[{ patientId: start.patientId, appointmentId: start.appointmentId, taskId: start.taskId }]} submitLabel="Create draft invoice" pendingLabel="Creating…">
          <InvoiceFields initial={initial} minDue={today} />
        </KeepForm>
      </Card>
      <p className="mt-4 text-sm text-ink-muted">The invoice is saved as a draft first. You can check and edit it, then issue it from the next page.</p>
    </>
  );
}
