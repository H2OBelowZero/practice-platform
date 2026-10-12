import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { uuid } from "@/lib/billing/input";
import { METHOD_LABEL } from "@/lib/billing/list";
import { getBillingPractice } from "@/lib/billing/practice";
import { formatZar } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDayShort } from "@/lib/time";
import { PageHeader } from "@/components/ui/page-header";
import { PrintButton } from "@/components/ui/print-button";

export const metadata = { title: "Receipt" };

/**
 * A printable receipt for one payment. Psychologist, admin and bookkeeper; the patient's name is shown to the first two only (the page does not
 * read the patients table for the bookkeeper). The payment must belong to the invoice in the URL and have succeeded, else 404.
 */
export default async function ReceiptPage({ params }: { params: Promise<{ invoiceId: string; paymentId: string }> }) {
  const me = await requireRole(["psychologist", "admin", "bookkeeper"]);
  const p = await params;
  const invoiceId = uuid.safeParse(p.invoiceId), paymentId = uuid.safeParse(p.paymentId);
  if (!invoiceId.success || !paymentId.success) notFound();

  const sb = await supabaseServer();
  const [invR, payR] = await Promise.all([
    sb.from("invoices").select("id, number, patient_id, status, total_cents, vat_cents").eq("id", invoiceId.data).maybeSingle(),
    sb.from("payments").select("id, method, reference, gateway_ref, amount_cents, received_on, status").eq("id", paymentId.data).eq("invoice_id", invoiceId.data).maybeSingle(),
  ]);
  const inv = invR.data, pay = payR.data;
  if (!inv || !pay || pay.status !== "succeeded") notFound();
  const practice = await getBillingPractice();
  const { data: pat } = me.role === "bookkeeper" ? { data: null } : await sb.from("patients").select("first_name, last_name").eq("id", inv.patient_id).maybeSingle();
  const ref = (pay.reference ?? pay.gateway_ref) as string | null;

  return (
    <>
      <div className="no-print">
        <PageHeader title="Receipt" description={<Link href={`/app/billing/${inv.id}`}>Back to invoice {inv.number}</Link>} actions={<PrintButton />} />
      </div>
      <article aria-labelledby="receipt-h" className="print-sheet mx-auto max-w-2xl rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
        <header className="mb-6 border-b border-line pb-4">
          <p className="font-serif text-2xl font-semibold">{practice?.name ?? "Practice"}</p>
          {practice?.registration_no && <p className="text-sm">Practice number: {practice.registration_no}</p>}
          {practice?.hpcsa_no && <p className="text-sm">HPCSA number: {practice.hpcsa_no}</p>}
        </header>
        <h1 id="receipt-h" className="mb-4 text-2xl">Payment receipt</h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-muted">Invoice</dt><dd className="font-medium">{inv.number}</dd>
          {pat && <><dt className="text-ink-muted">Patient</dt><dd className="font-medium">{pat.first_name} {pat.last_name}</dd></>}
          <dt className="text-ink-muted">Date received</dt><dd className="font-medium">{sastDayShort(pay.received_on as string, true)}</dd>
          <dt className="text-ink-muted">Method</dt><dd className="font-medium">{METHOD_LABEL[pay.method as string] ?? pay.method}</dd>
          {ref && <><dt className="text-ink-muted">Reference</dt><dd className="font-medium break-all">{ref}</dd></>}
          <dt className="text-ink-muted">Amount received</dt><dd className="text-xl font-semibold">{formatZar(pay.amount_cents as number)}</dd>
        </dl>
        <p className="mt-6 text-sm text-ink-muted">
          {(inv.vat_cents as number) > 0
            ? `Invoice ${inv.number} totals ${formatZar(inv.total_cents as number)}, which includes VAT of ${formatZar(inv.vat_cents as number)}.`
            : `No VAT is charged on invoice ${inv.number}.`}
        </p>
      </article>
    </>
  );
}
