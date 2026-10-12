import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { invoiceAuditFilter, invoiceEventText, isOverdue, METHOD_LABEL, PAYER_LABEL, ROLE_LABEL } from "@/lib/billing/list";
import { billingNotice } from "@/lib/billing/notices";
import { defaultDueDate, uuid } from "@/lib/billing/input";
import { outstandingCents } from "@/lib/billing/outstanding";
import { portionSummary } from "@/lib/billing/portions";
import { formatZar, formatZarInput } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel, sastDayShort, sastTime } from "@/lib/time";
import { ActionButton, FocusOnMount } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { addCreditNote, issueInvoice, recordPayment, saveDraft, voidInvoice } from "../actions";
import { InvoiceFields } from "../invoice-fields";
import { KeepForm } from "../keep-form";
import { CreditFields } from "./credit-fields";
import { PaymentForm } from "./payment-form";

export const metadata = { title: "Invoice" };

type Inv = {
  id: string; number: string; patient_id: string; appointment_id: string | null; status: string; payer_type: string; issue_date: string; due_date: string;
  subtotal_cents: number; discount_cents: number; vat_cents: number; total_cents: number; scheme_portion_cents: number; patient_portion_cents: number;
};
type Line = { id: string; description: string; quantity: number; unit_cents: number };
type Pay = { id: string; method: string; reference: string | null; gateway_ref: string | null; amount_cents: number; received_on: string; recorded_by: string | null };
type Credit = { id: string; amount_cents: number; portion: string; reason?: string; created_at: string };
type Claim = { id: string; status: string; claimed_cents: number; approved_cents: number | null };
type Ev = { id: number; actor_id: string | null; role: string | null; action: string; at: string };

const TH = "px-4 py-3 font-medium";
const day = (d: string) => sastDayShort(d, true);

/**
 * One invoice. Psychologist, admin and bookkeeper may open it (the bookkeeper read-only, and without the patient's name or a link to the patient).
 * A draft is edited here and issued; once issued the lines and figures are frozen by the database and shown as text.
 * History (the audit log for this invoice) is psychologist only.
 */
export default async function InvoicePage({ params, searchParams }: { params: Promise<{ invoiceId: string }>; searchParams: Promise<{ notice?: string; confirm?: string }> }) {
  const me = await requireRole(["psychologist", "admin", "bookkeeper"]);
  const id = uuid.safeParse((await params).invoiceId);
  if (!id.success) notFound();
  const sp = await searchParams;
  const write = me.role !== "bookkeeper";
  const today = sastDate(new Date());

  const sb = await supabaseServer();
  const { data } = await sb.from("invoices")
    .select("id, number, patient_id, appointment_id, status, payer_type, issue_date, due_date, subtotal_cents, discount_cents, vat_cents, total_cents, scheme_portion_cents, patient_portion_cents")
    .eq("id", id.data).maybeSingle();
  const inv = data as Inv | null;
  if (!inv) notFound();

  const [linesR, paysR, creditsR, claimsR, patR, evR] = await Promise.all([
    sb.from("invoice_lines").select("id, description, quantity, unit_cents").eq("invoice_id", inv.id).order("position").order("id"),
    sb.from("payments").select("id, method, reference, gateway_ref, amount_cents, received_on, recorded_by").eq("invoice_id", inv.id).eq("status", "succeeded").order("received_on").order("created_at"),
    sb.from("credit_notes").select(write ? "id, amount_cents, portion, reason, created_at" : "id, amount_cents, portion, created_at").eq("invoice_id", inv.id).order("created_at"),
    sb.from("claim_summary").select("id, status, claimed_cents, approved_cents").eq("invoice_id", inv.id),
    write ? sb.from("patients").select("first_name, last_name").eq("id", inv.patient_id).maybeSingle() : Promise.resolve({ data: null }),
    me.role === "psychologist" ? sb.from("audit_log").select("id, actor_id, role, action, at").or(invoiceAuditFilter(inv.id)).order("id", { ascending: false }).limit(100) : Promise.resolve({ data: null }),
  ]);
  const lines = (linesR.data ?? []) as Line[];
  const pays = (paysR.data ?? []) as Pay[];
  const credits = (creditsR.data ?? []) as unknown as Credit[];
  const claims = (claimsR.data ?? []) as Claim[];
  const events = (evR.data ?? []) as Ev[];
  const loadFailed = !!(linesR.error || paysR.error || creditsR.error);

  const paid = pays.reduce((s, p) => s + p.amount_cents, 0);
  const credited = credits.reduce((s, c) => s + c.amount_cents, 0);
  const open = inv.status === "issued" || inv.status === "part_paid";
  const outstanding = open ? outstandingCents({ totalCents: inv.total_cents, creditCents: credited, paidCents: paid }) : 0;
  const sum = portionSummary({ status: inv.status, totalCents: inv.total_cents, schemeCents: inv.scheme_portion_cents, patientCents: inv.patient_portion_cents, credits: credits.map((c) => ({ portion: c.portion, amountCents: c.amount_cents })), payments: pays.map((p) => ({ method: p.method, amountCents: p.amount_cents })) });
  const overdue = isOverdue(inv, today);
  const patient = patR.data as { first_name: string; last_name: string } | null;
  const notice = billingNotice(sp.notice);
  const draft = inv.status === "draft";

  // who recorded each payment and who did each logged step (display names are not shown for payments: role only)
  const userIds = [...new Set([...pays.map((p) => p.recorded_by), ...events.map((e) => e.actor_id)].filter((x): x is string => !!x))];
  const { data: profs } = userIds.length ? await sb.from("profiles").select("user_id, role, display_name").in("user_id", userIds) : { data: [] };
  const roleOf = new Map((profs ?? []).map((p) => [p.user_id as string, p.role as string]));
  const nameOf = new Map((profs ?? []).map((p) => [p.user_id as string, (p.display_name as string | null) || "Unnamed user"]));

  const voidable = write && (draft || inv.status === "issued");
  const confirmVoid = voidable && sp.confirm === "void";

  return (
    <>
      <PageHeader title={`Invoice ${inv.number}`} description={<Link href="/app/billing">Back to billing</Link>} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {loadFailed && <Notice tone="error">Some of this invoice could not be loaded. Please refresh the page before relying on the figures.</Notice>}

      <Card className="mb-6">
        <div className="mb-5 flex flex-wrap gap-2"><StatusChip status={inv.status} />{overdue && <StatusChip status="overdue" />}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          {write && <><dt className="text-ink-muted">Patient</dt><dd className="font-medium">{patient ? <Link href={`/app/patients/${inv.patient_id}`}>{patient.first_name} {patient.last_name}</Link> : "Unknown patient"}</dd></>}
          <dt className="text-ink-muted">Who pays</dt><dd className="font-medium">{PAYER_LABEL[inv.payer_type] ?? inv.payer_type}</dd>
          <dt className="text-ink-muted">Issued</dt><dd className="font-medium">{draft ? "Not issued yet" : day(inv.issue_date)}</dd>
          <dt className="text-ink-muted">Due</dt><dd className="font-medium">{day(inv.due_date)}</dd>
          {inv.appointment_id && write && <><dt className="text-ink-muted">Appointment</dt><dd className="font-medium"><Link href={`/app/calendar/${inv.appointment_id}`}>Open the appointment</Link></dd></>}
        </dl>
      </Card>

      {draft && write ? (
        <section aria-labelledby="edit-h" className="mb-6">
          <h2 id="edit-h" className="mb-4">Edit the draft</h2>
          <Card>
            <KeepForm action={saveDraft} args={[inv.id]} submitLabel="Save draft" pendingLabel="Saving…">
              <InvoiceFields minDue={today} initial={{
                lines: lines.map((l) => ({ description: l.description, quantity: String(l.quantity), price: formatZarInput(l.unit_cents) })),
                discount: inv.discount_cents ? formatZarInput(inv.discount_cents) : "", dueDate: inv.due_date < today ? defaultDueDate(today) : inv.due_date,
                payer: inv.payer_type, scheme: inv.payer_type === "split" ? formatZarInput(inv.scheme_portion_cents) : "",
              }} />
            </KeepForm>
          </Card>
        </section>
      ) : (
        <section aria-labelledby="lines-h" className="mb-6">
          <h2 id="lines-h" className="mb-4">Lines</h2>
          <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Invoice lines</caption>
              <thead className="bg-sunk text-sm text-ink-muted"><tr>
                <th scope="col" className={TH}>Description</th><th scope="col" className={`${TH} text-right`}>Qty</th>
                <th scope="col" className={`${TH} text-right`}>Price each</th><th scope="col" className={`${TH} text-right`}>Amount</th>
              </tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-t border-line align-top">
                    <th scope="row" className="px-4 py-3 font-normal">{l.description}</th>
                    <td className="px-4 py-3 text-right">{l.quantity}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(l.unit_cents)}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(l.quantity * l.unit_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section aria-labelledby="totals-h" className="mb-6">
        <h2 id="totals-h" className="mb-4">Totals</h2>
        <Card>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2">
            <dt>Subtotal</dt><dd className="text-right">{formatZar(inv.subtotal_cents)}</dd>
            <dt>Discount</dt><dd className="text-right">{inv.discount_cents ? `-${formatZar(inv.discount_cents)}` : formatZar(0)}</dd>
            <dt>VAT</dt><dd className="text-right">{formatZar(inv.vat_cents)}</dd>
            <dt className="font-semibold">Total</dt><dd className="text-right font-semibold">{formatZar(inv.total_cents)}</dd>
            {!draft && inv.status !== "void" && <>
              <dt className="text-ink-muted">Credit notes</dt><dd className="text-right">{credited ? `-${formatZar(credited)}` : formatZar(0)}</dd>
              <dt className="text-ink-muted">Paid</dt><dd className="text-right">{paid ? `-${formatZar(paid)}` : formatZar(0)}</dd>
              <dt className="font-semibold">Outstanding</dt><dd className="text-right font-semibold">{formatZar(outstanding)}</dd>
            </>}
          </dl>
          {draft && <p className="mt-3 text-sm text-ink-muted">These figures are as last saved. They are recalculated each time you save the draft.</p>}
        </Card>
      </section>

      {inv.payer_type !== "self" && (
        <section aria-labelledby="portions-h" className="mb-6">
          <h2 id="portions-h" className="mb-4">Medical aid and patient portions</h2>
          <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Who should pay what, and what has been received</caption>
              <thead className="bg-sunk text-sm text-ink-muted"><tr>
                <th scope="col" className={TH}>Portion</th><th scope="col" className={`${TH} text-right`}>Expected</th>
                <th scope="col" className={`${TH} text-right`}>Received</th><th scope="col" className={`${TH} text-right`}>Credit notes</th><th scope="col" className={`${TH} text-right`}>Still owed</th>
              </tr></thead>
              <tbody>
                <tr className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">Medical aid</th><td className="px-4 py-3 text-right">{formatZar(sum.schemeExpectedCents)}</td><td className="px-4 py-3 text-right">{formatZar(sum.schemePaidCents)}</td><td className="px-4 py-3 text-right">{sum.schemeCreditCents ? `-${formatZar(sum.schemeCreditCents)}` : formatZar(0)}</td><td className="px-4 py-3 text-right">{sum.perPortion ? formatZar(sum.perPortion.schemeCents) : "-"}</td></tr>
                <tr className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">Patient</th><td className="px-4 py-3 text-right">{formatZar(sum.patientExpectedCents)}</td><td className="px-4 py-3 text-right">{formatZar(sum.patientPaidCents)}</td><td className="px-4 py-3 text-right">{sum.patientCreditCents ? `-${formatZar(sum.patientCreditCents)}` : formatZar(0)}</td><td className="px-4 py-3 text-right">{sum.perPortion ? formatZar(sum.perPortion.patientCents) : "-"}</td></tr>
                <tr className="border-t border-line bg-sunk"><th scope="row" className="px-4 py-3 font-semibold">Outstanding overall</th><td className="px-4 py-3 text-right">-</td><td className="px-4 py-3 text-right">-</td><td className="px-4 py-3 text-right">-</td><td className="px-4 py-3 text-right font-semibold">{draft || inv.status === "void" ? "-" : formatZar(sum.outstandingCents)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-sm text-ink-muted">Each credit note is for one portion: writing off what the medical aid did not pay, or a discount for the patient. The patient can pay online once the medical aid portion has been paid or written off.</p>
        </section>
      )}

      {draft && write && (
        <Card className="mb-6">
          <h2 className="mb-2 text-lg">Issue this invoice</h2>
          <p className="mb-4 text-ink-muted">{inv.total_cents === 0 ? "The total is R 0,00, so it cannot be issued yet. Add an amount to a line first." : "Check the lines and totals above first."}</p>
          <KeepForm action={issueInvoice} args={[inv.id]} submitLabel="Issue invoice" pendingLabel="Issuing…"
            confirm={{ title: `Issue invoice ${inv.number}?`, yes: "Yes, issue this invoice",
              body: <p>Issuing cannot be undone: the lines and amounts are frozen, today becomes the issue date, and the patient is emailed a link to their payments page if they have an email address and agreed to email. A mistake afterwards means voiding the invoice or adding a credit note.</p> }} />
        </Card>
      )}

      {!draft && (
        <section aria-labelledby="pay-h" className="mb-6">
          <h2 id="pay-h" className="mb-4">Payments</h2>
          {pays.length === 0 ? <p className="mb-4 text-ink-muted">No payments have been recorded.</p> : (
            <div className="mb-4 overflow-x-auto rounded-card border border-line bg-surface shadow-card">
              <table className="w-full border-collapse text-left">
                <caption className="sr-only">Payments received</caption>
                <thead className="bg-sunk text-sm text-ink-muted"><tr>
                  <th scope="col" className={TH}>Received</th><th scope="col" className={TH}>Method</th><th scope="col" className={TH}>Reference</th>
                  <th scope="col" className={`${TH} text-right`}>Amount</th><th scope="col" className={TH}>Recorded by</th><th scope="col" className={TH}><span className="sr-only">Receipt</span></th>
                </tr></thead>
                <tbody>
                  {pays.map((p) => (
                    <tr key={p.id} className="border-t border-line align-top">
                      <td className="px-4 py-3 whitespace-nowrap">{day(p.received_on)}</td>
                      <td className="px-4 py-3">{METHOD_LABEL[p.method] ?? p.method}</td>
                      <td className="px-4 py-3 break-all">{p.reference ?? p.gateway_ref ?? <span className="text-ink-muted">None</span>}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(p.amount_cents)}</td>
                      <td className="px-4 py-3">{p.recorded_by ? (ROLE_LABEL[roleOf.get(p.recorded_by) ?? ""] ?? "Staff") : "System"}</td>
                      <td className="px-4 py-3"><Link href={`/app/billing/${inv.id}/receipts/${p.id}`} aria-label={`Receipt for ${formatZar(p.amount_cents)} received ${day(p.received_on)}`}>Receipt</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {write && open && outstanding > 0 && (
            <Card>
              <h3 className="mb-3 text-lg">Record a payment</h3>
              <PaymentForm action={recordPayment} invoiceId={inv.id} outstandingCents={outstanding} today={today} />
            </Card>
          )}
        </section>
      )}

      {!draft && (
        <section aria-labelledby="credit-h" className="mb-6">
          <h2 id="credit-h" className="mb-4">Credit notes</h2>
          {credits.length === 0 ? <p className="mb-4 text-ink-muted">No credit notes.</p> : (
            <ul className="m-0 mb-4 grid list-none gap-3 p-0">
              {credits.map((c) => (
                <li key={c.id} className="rounded-xl border border-line bg-surface p-4">
                  <p className="font-medium">{formatZar(c.amount_cents)}{inv.payer_type !== "self" && <span className="font-normal text-ink-muted"> · {c.portion === "scheme" ? "Medical aid shortfall written off" : "Discount or write-off for the patient"}</span>}</p>
                  <p>{write ? c.reason : "-"}</p>
                  <p className="text-sm text-ink-muted">{sastDateLabel(c.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
          {me.role === "psychologist" && open && outstanding > 0 && (
            <Card>
              <h3 className="mb-3 text-lg">Add a credit note</h3>
              <p className="mb-4 text-ink-muted">Reduces what is owed (for example a discount or a corrected fee). It cannot be more than the {formatZar(outstanding)} still owed, and it cannot be undone.</p>
              <KeepForm action={addCreditNote} args={[inv.id]} submitLabel="Add credit note" pendingLabel="Adding…"
                confirm={{ title: "Add this credit note?", yes: "Yes, add the credit note",
                  body: <p>A credit note cannot be changed or removed. It reduces what is owed on this invoice (against the portion you chose), and if it covers everything still owed on an unpaid invoice the invoice becomes void.</p> }}>
                <CreditFields payer={inv.payer_type} />
              </KeepForm>
            </Card>
          )}
        </section>
      )}

      {(inv.payer_type !== "self" || claims.length > 0) && !draft && (
        <section aria-labelledby="claims-h" className="mb-6">
          <h2 id="claims-h" className="mb-4">Medical aid claims</h2>
          {claims.length === 0 ? <p className="text-ink-muted">No claim has been started for this invoice.</p> : (
            <ul className="m-0 grid list-none gap-3 p-0">
              {claims.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4">
                  <StatusChip status={c.status} />
                  <span>Claimed {formatZar(c.claimed_cents)}{c.approved_cents !== null ? `, approved ${formatZar(c.approved_cents)}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {voidable && (
        <section aria-labelledby="void-h" className="mb-6">
          <h2 id="void-h" className="mb-4">Void this invoice</h2>
          {confirmVoid ? (
            <FocusOnMount id="void-panel" className="rounded-card border border-danger bg-danger-tint p-5">
              <h3 className="mb-2 text-lg">Void invoice {inv.number}?</h3>
              <p className="mb-4">A void invoice can never be used again. {inv.appointment_id ? "The appointment can then be invoiced again. " : ""}This cannot be undone.</p>
              <div className="flex flex-wrap items-start gap-3">
                <ActionButton action={voidInvoice} args={[inv.id]} submitLabel="Yes, void this invoice" pendingLabel="Voiding…" variant="danger" />
                <LinkButton href={`/app/billing/${inv.id}`} variant="secondary">No, keep it</LinkButton>
              </div>
            </FocusOnMount>
          ) : (
            <LinkButton href={`/app/billing/${inv.id}?confirm=void#void-panel`} variant="secondary">Void invoice</LinkButton>
          )}
        </section>
      )}
      {write && inv.status === "part_paid" && <p className="mb-6 text-ink-muted">This invoice has payments, so it cannot be voided. Use a credit note to reduce what is owed.</p>}

      {me.role === "psychologist" && (
        <section aria-labelledby="hist-h">
          <h2 id="hist-h" className="mb-4">History</h2>
          {events.length === 0 ? <p className="text-ink-muted">No history recorded.</p> : (
            <ol className="m-0 grid list-none gap-3 p-0">
              {events.map((e) => (
                <li key={e.id} className="rounded-xl border border-line bg-surface p-4">
                  <p className="font-medium">{invoiceEventText(e.action)}</p>
                  <p className="text-sm text-ink-muted">{e.actor_id ? (nameOf.get(e.actor_id) ?? "Another user") : "System"} · {sastDateLabel(e.at)} at {sastTime(e.at)} (SAST)</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
