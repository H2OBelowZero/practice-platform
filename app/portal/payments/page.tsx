import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { PAYER_LABEL, METHOD_LABEL } from "@/lib/billing/list";
import { getBillingPractice } from "@/lib/billing/practice";
import { formatZar } from "@/lib/money";
import { payfastAvailable } from "@/lib/payments/payfast";
import { loadPortalPayments } from "@/lib/portal/load";
import {
  DEFAULT_PAYMENT_INSTRUCTIONS, hasPortalReceipt, hidePayNow, orderInvoices, PAY_ONLINE_UNAVAILABLE, parsePaidParam, RETURN_TEXT, returnState, summarise,
  type PortalInvoice,
} from "@/lib/portal/payments";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDayShort } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { PayNow } from "./pay-now";

export const metadata = { title: "Payments" };

/**
 * Invoices, what is owed, how to pay and receipts for the signed-in patient or, for a guardian, the children they may pay for.
 * Everything is read through the user's own client (RLS): a guardian without permissions.pay sees nothing. Pay now is decided per invoice by
 * payNowAllowed() here AND again in the server action. `?paid=<invoice id>` (PayFast's return URL) only chooses which invoice the status banner is
 * about; the banner reads stored data (invoice status, payment rows) and never marks anything paid.
 */
export default async function PortalPayments({ searchParams }: { searchParams: Promise<{ paid?: string | string[] }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const paidId = parsePaidParam((await searchParams).paid);
  const today = sastDate(new Date());
  const sb = await supabaseServer();

  let loaded: Awaited<ReturnType<typeof loadPortalPayments>> | null = null;
  try { loaded = await loadPortalPayments(sb, me.userId, today); } catch (e) { console.error(e instanceof Error ? e.message : "portal payments load failed"); }
  const practice = await getBillingPractice();
  const online = payfastAvailable();

  if (!loaded) {
    return (
      <>
        <PageHeader title="Payments" description="What you owe, how to pay, and your receipts." />
        <Notice tone="error">We could not load your invoices. Please refresh the page. If this keeps happening, contact the practice.</Notice>
      </>
    );
  }

  const { list, payments } = loaded;
  const { open, closed } = orderInvoices(list);
  const sum = summarise(list);
  const numberOf = new Map(list.map((i) => [i.id, i]));
  const ret = paidId ? returnState(numberOf.get(paidId), payments.filter((p) => p.invoice_id === paidId)) : "none";
  const returned = paidId ? numberOf.get(paidId) : undefined;
  const receipts = payments.filter((p) => hasPortalReceipt(p.method) && numberOf.has(p.invoice_id)).slice(0, 10);
  const instructions = practice?.payment_instructions?.trim() || DEFAULT_PAYMENT_INSTRUCTIONS;

  const card = (i: PortalInvoice) => (
    <li key={i.id}>
      <Card className={i.id === paidId ? "border-sage-500 border-2" : undefined}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg"><Link href={`/portal/payments/${i.id}`}>Invoice {i.number}</Link></h3>
            {i.forName && <p className="text-ink-muted">For <strong className="text-ink">{i.forName}</strong></p>}
          </div>
          <div className="flex flex-wrap gap-2"><StatusChip status={i.status} />{i.overdue && <StatusChip status="overdue" />}</div>
        </div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          <dt className="text-ink-muted">Issued</dt><dd>{sastDayShort(i.issueDate, true)}</dd>
          <dt className="text-ink-muted">Due</dt><dd>{sastDayShort(i.dueDate, true)}</dd>
          <dt className="text-ink-muted">Who pays</dt><dd>{PAYER_LABEL[i.payerType] ?? i.payerType}</dd>
          <dt className="text-ink-muted">Total</dt><dd>{formatZar(i.totalCents)}</dd>
          <dt className="text-ink-muted">Outstanding</dt><dd className="font-semibold">{formatZar(i.outstandingCents)}</dd>
        </dl>
        {i.open && (
          <div className="mt-4 rounded-xl bg-sunk p-4">
            {hidePayNow(paidId, i.id, ret)
              ? <p>Waiting for confirmation of your payment. Please do not pay again.</p> // I1: the PayFast return URL names this invoice
              : i.payNow.allowed
                ? online
                  ? <PayNow invoiceId={i.id} amountCents={i.payNow.amountCents} amountLabel={formatZar(i.payNow.amountCents)} invoiceNumber={i.number} />
                  : <p>{PAY_ONLINE_UNAVAILABLE}</p>
                : <p>{i.noPayText}</p>}
          </div>
        )}
        <div className="mt-4"><LinkButton href={`/portal/payments/${i.id}`} variant="secondary" aria-label={`View invoice ${i.number}`}>View</LinkButton></div>
      </Card>
    </li>
  );

  return (
    <>
      <PageHeader title="Payments" description="What you owe, how to pay, and your receipts." />

      {ret === "confirming" && (
        <Notice tone="info" title="Confirming your payment">
          <p>{RETURN_TEXT.confirming}</p>
          <p><Link href={`/portal/payments?paid=${paidId}`}>Refresh</Link></p>
        </Notice>
      )}
      {ret === "paid" && returned && (
        <Notice tone="success" title="Paid">
          <p>{RETURN_TEXT.paid} {returned.status === "paid" ? `Invoice ${returned.number} is now paid in full.` : `We have received your payment for invoice ${returned.number}.`} <Link href={`/portal/payments/${returned.id}`}>View the invoice and receipt</Link>.</p>
        </Notice>
      )}

      <section aria-labelledby="sum-h" className="mb-10">
        <h2 id="sum-h" className="sr-only">Amount outstanding</h2>
        <Card>
          <p className="text-ink-muted">Amount outstanding</p>
          <p className="my-1 text-3xl font-semibold" data-testid="amount-outstanding">{formatZar(sum.outstandingCents)}</p>
          {sum.openCount === 0
            ? <p>You have nothing to pay right now.</p>
            : <>
                <p>{sum.payableNowCents > 0 ? `${formatZar(sum.payableNowCents)} can be paid online now.` : "Nothing can be paid online at the moment."}</p>
                {sum.awaitingSchemeCents > 0 && <p className="text-ink-muted">{formatZar(sum.awaitingSchemeCents)} is still with your medical aid. You can pay your portion once it has been settled.</p>}
              </>}
        </Card>
      </section>

      <section aria-labelledby="open-h" className="mb-10">
        <h2 id="open-h" className="mb-4">Invoices to pay</h2>
        {open.length === 0
          ? <p className="text-ink-muted">{list.length === 0 ? "There are no invoices to show yet. If you expected to see invoices here, please contact the practice." : "No invoices are waiting for payment."}</p>
          : <ul className="grid list-none gap-4 p-0">{open.map(card)}</ul>}
      </section>

      {closed.length > 0 && (
        <section aria-labelledby="closed-h" className="mb-10">
          <h2 id="closed-h" className="mb-4">Paid and closed invoices</h2>
          <ul className="grid list-none gap-4 p-0">{closed.map(card)}</ul>
        </section>
      )}

      <section aria-labelledby="rec-h" className="mb-10">
        <h2 id="rec-h" className="mb-4">Recent payments and receipts</h2>
        {receipts.length === 0 ? <p className="text-ink-muted">No payments yet.</p> : (
          <ul className="grid list-none gap-3 p-0">
            {receipts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
                <div>
                  <p className="font-medium">{formatZar(p.amount_cents)} · {METHOD_LABEL[p.method] ?? p.method}</p>
                  <p className="text-sm text-ink-muted">{sastDayShort(p.received_on, true)} · Invoice {numberOf.get(p.invoice_id)?.number}{numberOf.get(p.invoice_id)?.forName ? ` · For ${numberOf.get(p.invoice_id)?.forName}` : ""}</p>
                </div>
                <Link href={`/portal/payments/${p.invoice_id}/receipts/${p.id}`} aria-label={`Receipt for ${formatZar(p.amount_cents)} received ${sastDayShort(p.received_on, true)}`}>Receipt</Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="eft-h">
        <h2 id="eft-h" className="mb-4">Pay by EFT</h2>
        <Card>
          <p className="whitespace-pre-wrap break-words">{instructions}</p>
          <p className="mt-3 text-sm text-ink-muted">Please use the invoice number as your payment reference.</p>
        </Card>
      </section>
    </>
  );
}
