import Link from "next/link";
import { notFound } from "next/navigation";
import { uuid } from "@/lib/billing/input";
import { getBillingPractice } from "@/lib/billing/practice";
import { requireRole } from "@/lib/auth/session";
import { hasPortalReceipt, receiptView } from "@/lib/portal/payments";
import { supabaseServer } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { PrintButton } from "@/components/ui/print-button";

export const metadata = { title: "Receipt" };

/**
 * A printable receipt for one payment the patient (or guardian) made. Read through RLS: another person's invoice or payment comes back empty
 * and the page answers 404. The payment must belong to the invoice in the URL, have succeeded, and not be the medical aid's own remittance.
 */
export default async function PortalReceipt({ params }: { params: Promise<{ invoiceId: string; paymentId: string }> }) {
  await requireRole(["patient", "guardian"]);
  const p = await params;
  const invoiceId = uuid.safeParse(p.invoiceId), paymentId = uuid.safeParse(p.paymentId);
  if (!invoiceId.success || !paymentId.success) notFound();

  const sb = await supabaseServer();
  const [invR, payR] = await Promise.all([
    sb.from("invoices").select("id, number, patient_id, status, total_cents, vat_cents").eq("id", invoiceId.data).neq("status", "draft").maybeSingle(),
    sb.from("payments").select("id, method, reference, gateway_ref, amount_cents, received_on, status").eq("id", paymentId.data).eq("invoice_id", invoiceId.data).maybeSingle(),
  ]);
  const inv = invR.data, pay = payR.data;
  if (!inv || !pay || pay.status !== "succeeded" || !hasPortalReceipt(pay.method as string)) notFound();

  const [practice, patR] = await Promise.all([
    getBillingPractice(),
    sb.from("patients").select("first_name, last_name").eq("id", inv.patient_id).maybeSingle(),
  ]);
  const r = receiptView({
    practice, patient: (patR.data as { first_name: string; last_name: string } | null) ?? null,
    invoice: { number: inv.number as string, total_cents: inv.total_cents as number, vat_cents: inv.vat_cents as number },
    payment: pay as { method: string; amount_cents: number; received_on: string; reference: string | null; gateway_ref: string | null },
  });

  return (
    <>
      <div className="no-print">
        <PageHeader title="Receipt" description={<Link href={`/portal/payments/${inv.id}`}>Back to invoice {r.invoiceNumber}</Link>} actions={<PrintButton />} />
      </div>
      <article aria-labelledby="receipt-h" className="print-sheet mx-auto max-w-2xl rounded-card border border-line bg-surface p-6 shadow-card sm:p-8">
        <header className="mb-6 border-b border-line pb-4">
          <p className="font-serif text-2xl font-semibold">{r.practiceName}</p>
          {r.practiceNumber && <p className="text-sm">Practice number: {r.practiceNumber}</p>}
          {r.hpcsaNumber && <p className="text-sm">HPCSA number: {r.hpcsaNumber}</p>}
        </header>
        <h1 id="receipt-h" className="mb-4 text-2xl">Payment receipt</h1>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-muted">Invoice</dt><dd className="font-medium">{r.invoiceNumber}</dd>
          {r.patientName && <><dt className="text-ink-muted">Patient</dt><dd className="font-medium">{r.patientName}</dd></>}
          <dt className="text-ink-muted">Date received</dt><dd className="font-medium">{r.dateReceived}</dd>
          <dt className="text-ink-muted">Method</dt><dd className="font-medium">{r.method}</dd>
          {r.reference && <><dt className="text-ink-muted">Reference</dt><dd className="font-medium break-all">{r.reference}</dd></>}
          <dt className="text-ink-muted">Amount received</dt><dd className="text-xl font-semibold">{r.amount}</dd>
        </dl>
        <p className="mt-6 text-sm text-ink-muted">{r.vatNote}</p>
      </article>
    </>
  );
}
