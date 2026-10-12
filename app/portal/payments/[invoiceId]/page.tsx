import Link from "next/link";
import { notFound } from "next/navigation";
import { uuid } from "@/lib/billing/input";
import { PAYER_LABEL, METHOD_LABEL, paymentRef } from "@/lib/billing/list";
import { payNowAllowed } from "@/lib/billing/pay-now";
import { portionSummary } from "@/lib/billing/portions";
import { requireRole } from "@/lib/auth/session";
import { formatZar } from "@/lib/money";
import { payfastAvailable } from "@/lib/payments/payfast";
import { creditText, hasPortalReceipt, hidePayNow, isOpenStatus, parsePaidParam, PAY_ONLINE_UNAVAILABLE, payNowReasonText, RETURN_TEXT, returnState } from "@/lib/portal/payments";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel, sastDayShort } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { PayNow } from "../pay-now";

export const metadata = { title: "Invoice" };

type Inv = {
  id: string; number: string; patient_id: string; status: string; payer_type: string; issue_date: string; due_date: string;
  subtotal_cents: number; discount_cents: number; vat_cents: number; total_cents: number; scheme_portion_cents: number; patient_portion_cents: number;
};
const TH = "px-4 py-3 font-medium";

/**
 * One invoice for the signed-in patient or guardian. Read through RLS: another person's invoice (or a draft) simply does not come back, and the
 * page answers 404. No claim, diagnosis or credit-note reason is read here: the medical aid portion is shown as plain figures from payments and
 * credit notes.
 */
export default async function PortalInvoice({ params, searchParams }: { params: Promise<{ invoiceId: string }>; searchParams: Promise<{ paid?: string | string[] }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const id = uuid.safeParse((await params).invoiceId);
  if (!id.success) notFound();
  const sb = await supabaseServer();

  const { data } = await sb.from("invoices")
    .select("id, number, patient_id, status, payer_type, issue_date, due_date, subtotal_cents, discount_cents, vat_cents, total_cents, scheme_portion_cents, patient_portion_cents")
    .eq("id", id.data).neq("status", "draft").maybeSingle();
  const inv = data as Inv | null;
  if (!inv) notFound();

  const [linesR, paysR, creditsR, patR] = await Promise.all([
    sb.from("invoice_lines").select("id, description, quantity, unit_cents").eq("invoice_id", inv.id).order("position").order("id"),
    sb.from("payments").select("id, method, reference, gateway_ref, amount_cents, received_on").eq("invoice_id", inv.id).eq("status", "succeeded").order("received_on").order("created_at"),
    sb.from("credit_notes").select("id, portion, amount_cents, created_at").eq("invoice_id", inv.id).order("created_at"),
    sb.from("patients").select("first_name, user_id").eq("id", inv.patient_id).maybeSingle(),
  ]);
  const loadFailed = !!(linesR.error || paysR.error || creditsR.error);
  const lines = (linesR.data ?? []) as { id: string; description: string; quantity: number; unit_cents: number }[];
  const pays = (paysR.data ?? []) as { id: string; method: string; reference: string | null; gateway_ref: string | null; amount_cents: number; received_on: string }[];
  const credits = (creditsR.data ?? []) as { id: string; portion: string; amount_cents: number; created_at: string }[];
  const forName = patR.data && patR.data.user_id !== me.userId ? (patR.data.first_name as string) : null;

  const payList = pays.map((p) => ({ method: p.method, amountCents: p.amount_cents }));
  const creditList = credits.map((c) => ({ portion: c.portion, amountCents: c.amount_cents }));
  const open = isOpenStatus(inv.status);
  const sum = portionSummary({ status: inv.status, totalCents: inv.total_cents, schemeCents: inv.scheme_portion_cents, patientCents: inv.patient_portion_cents, credits: creditList, payments: payList });
  const payNow = payNowAllowed({ status: inv.status, payerType: inv.payer_type, totalCents: inv.total_cents, schemePortionCents: inv.scheme_portion_cents, patientPortionCents: inv.patient_portion_cents, credits: creditList, payments: payList });
  const overdue = open && inv.due_date < sastDate(new Date());
  const online = payfastAvailable();
  // I1: arriving from PayFast for THIS invoice: show its stored status, never Pay now (a second click would be a second payment)
  const paidId = parsePaidParam((await searchParams).paid);
  const ret = paidId === inv.id ? returnState(inv, pays) : "none";
  const hide = hidePayNow(paidId, inv.id, ret);

  return (
    <>
      <PageHeader title={`Invoice ${inv.number}`} description={<Link href="/portal/payments">Back to payments</Link>} />
      {loadFailed && <Notice tone="error">Some of this invoice could not be loaded. Please refresh the page before relying on the figures.</Notice>}
      {ret === "confirming" && (
        <Notice tone="info" title="Confirming your payment">
          <p>{RETURN_TEXT.confirming}</p>
          <p><Link href={`/portal/payments/${inv.id}?paid=${inv.id}`}>Refresh</Link></p>
        </Notice>
      )}
      {ret === "paid" && <Notice tone="success" title="Paid">{RETURN_TEXT.paid}</Notice>}

      <Card className="mb-6">
        <div className="mb-5 flex flex-wrap gap-2"><StatusChip status={inv.status} />{overdue && <StatusChip status="overdue" />}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          {forName && <><dt className="text-ink-muted">For</dt><dd className="font-medium">{forName}</dd></>}
          <dt className="text-ink-muted">Who pays</dt><dd className="font-medium">{PAYER_LABEL[inv.payer_type] ?? inv.payer_type}</dd>
          <dt className="text-ink-muted">Issued</dt><dd className="font-medium">{sastDayShort(inv.issue_date, true)}</dd>
          <dt className="text-ink-muted">Due</dt><dd className="font-medium">{sastDayShort(inv.due_date, true)}</dd>
          {open && <><dt className="text-ink-muted">Outstanding</dt><dd className="text-xl font-semibold">{formatZar(sum.outstandingCents)}</dd></>}
        </dl>
        {open && (
          <div className="mt-5 rounded-xl bg-sunk p-4">
            {loadFailed
              ? <p>Online payment is paused until the page loads completely. Please refresh the page.</p> // M1: the figures cannot be trusted
              : hide
                ? <p>Waiting for confirmation of your payment. Please do not pay again.</p>
                : payNow.allowed
                  ? online
                    ? <PayNow invoiceId={inv.id} amountCents={payNow.amountCents} amountLabel={formatZar(payNow.amountCents)} invoiceNumber={inv.number} />
                    : <p>{PAY_ONLINE_UNAVAILABLE}</p>
                  : <p>{payNowReasonText(payNow.reason, { issueDate: inv.issue_date, today: sastDate(new Date()) })}</p>}
          </div>
        )}
      </Card>

      <section aria-labelledby="lines-h" className="mb-6">
        <h2 id="lines-h" className="mb-4">What this invoice is for</h2>
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

      <section aria-labelledby="totals-h" className="mb-6">
        <h2 id="totals-h" className="mb-4">Totals</h2>
        <Card>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2">
            <dt>Subtotal</dt><dd className="text-right">{formatZar(inv.subtotal_cents)}</dd>
            <dt>Discount</dt><dd className="text-right">{inv.discount_cents ? `-${formatZar(inv.discount_cents)}` : formatZar(0)}</dd>
            <dt>VAT</dt><dd className="text-right">{formatZar(inv.vat_cents)}</dd>
            <dt className="font-semibold">Total</dt><dd className="text-right font-semibold">{formatZar(inv.total_cents)}</dd>
            {inv.status !== "void" && <>
              <dt className="text-ink-muted">Credit notes</dt><dd className="text-right">{sum.creditCents ? `-${formatZar(sum.creditCents)}` : formatZar(0)}</dd>
              <dt className="text-ink-muted">Paid</dt><dd className="text-right">{pays.length ? `-${formatZar(sum.schemePaidCents + sum.patientPaidCents)}` : formatZar(0)}</dd>
              <dt className="font-semibold">Outstanding</dt><dd className="text-right font-semibold">{formatZar(sum.outstandingCents)}</dd>
            </>}
          </dl>
        </Card>
      </section>

      {inv.payer_type !== "self" && inv.status !== "void" && (
        <section aria-labelledby="split-h" className="mb-6">
          <h2 id="split-h" className="mb-4">Your medical aid and your part</h2>
          <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">What your medical aid and you each owe on this invoice</caption>
              <thead className="bg-sunk text-sm text-ink-muted"><tr>
                <th scope="col" className={TH}>Portion</th><th scope="col" className={`${TH} text-right`}>Share of the invoice</th>
                <th scope="col" className={`${TH} text-right`}>Paid</th><th scope="col" className={`${TH} text-right`}>Written off</th><th scope="col" className={`${TH} text-right`}>Still owed</th>
              </tr></thead>
              <tbody>
                <tr className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">Your medical aid</th><td className="px-4 py-3 text-right">{formatZar(sum.schemeExpectedCents)}</td><td className="px-4 py-3 text-right">{formatZar(sum.schemePaidCents)}</td><td className="px-4 py-3 text-right">{formatZar(sum.schemeCreditCents)}</td><td className="px-4 py-3 text-right">{sum.perPortion ? formatZar(sum.perPortion.schemeCents) : "-"}</td></tr>
                <tr className="border-t border-line"><th scope="row" className="px-4 py-3 font-medium">You</th><td className="px-4 py-3 text-right">{formatZar(sum.patientExpectedCents)}</td><td className="px-4 py-3 text-right">{formatZar(sum.patientPaidCents)}</td><td className="px-4 py-3 text-right">{formatZar(sum.patientCreditCents)}</td><td className="px-4 py-3 text-right">{sum.perPortion ? formatZar(sum.perPortion.patientCents) : "-"}</td></tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {credits.length > 0 && (
        <section aria-labelledby="cr-h" className="mb-6">
          <h2 id="cr-h" className="mb-4">Credit notes</h2>
          <ul className="m-0 grid list-none gap-3 p-0">
            {credits.map((c) => (
              <li key={c.id} className="rounded-xl border border-line bg-surface p-4">
                <p className="font-medium">{formatZar(c.amount_cents)}</p>
                <p>{creditText(c.portion)}</p>
                <p className="text-sm text-ink-muted">{sastDateLabel(c.created_at)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="pay-h">
        <h2 id="pay-h" className="mb-4">Payments</h2>
        {pays.length === 0 ? <p className="text-ink-muted">No payments have been received yet.</p> : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Payments received</caption>
              <thead className="bg-sunk text-sm text-ink-muted"><tr>
                <th scope="col" className={TH}>Received</th><th scope="col" className={TH}>Method</th><th scope="col" className={TH}>Reference</th>
                <th scope="col" className={`${TH} text-right`}>Amount</th><th scope="col" className={TH}><span className="sr-only">Receipt</span></th>
              </tr></thead>
              <tbody>
                {pays.map((p) => (
                  <tr key={p.id} className="border-t border-line align-top">
                    <td className="px-4 py-3 whitespace-nowrap">{sastDayShort(p.received_on, true)}</td>
                    <td className="px-4 py-3">{p.method === "medical_aid" ? "Paid by your medical aid" : (METHOD_LABEL[p.method] ?? p.method)}</td>
                    <td className="px-4 py-3 break-all">{paymentRef(p) ?? <span className="text-ink-muted">None</span>}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">{formatZar(p.amount_cents)}</td>
                    <td className="px-4 py-3">
                      {hasPortalReceipt(p.method)
                        ? <Link href={`/portal/payments/${inv.id}/receipts/${p.id}`} aria-label={`Receipt for ${formatZar(p.amount_cents)} received ${sastDayShort(p.received_on, true)}`}>Receipt</Link>
                        : <span className="text-ink-muted">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
