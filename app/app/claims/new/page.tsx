import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth/session";
import { claimableCents, INSURER_CONSENT_MISSING, insurerConsentState, isCurrentMember } from "@/lib/claims/rules";
import { TARIFF, uuid } from "@/lib/claims/input";
import { MANUAL_SUBMISSION_NOTE } from "@/lib/claims/view";
import { PAYER_LABEL } from "@/lib/billing/list";
import { formatZar, formatZarInput } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { KeepForm } from "../../billing/keep-form";
import { openClaim } from "../actions";
import { ClaimFields } from "../claim-fields";

export const metadata = { title: "New claim" };

type Inv = { id: string; number: string; patient_id: string; status: string; payer_type: string; scheme_portion_cents: number };
type Member = { id: string; scheme: string; plan: string | null; dependant_code: string | null; valid_from: string | null; valid_to: string | null };

/**
 * Open a draft medical aid claim for one invoice (?invoice=). Psychologist and admin; everyone else gets a 404. The psychologist may choose ICD-10 codes,
 * the admin opens the claim without them (the practitioner adds them on the claim). The page title carries no names or codes.
 */
export default async function NewClaimPage({ searchParams }: { searchParams: Promise<{ invoice?: string }> }) {
  const me = await requireRole(["psychologist", "admin"]);
  const invoiceId = uuid.safeParse((await searchParams).invoice);
  if (!invoiceId.success) notFound();
  const today = sastDate(new Date());

  const sb = await supabaseServer();
  const { data } = await sb.from("invoices").select("id, number, patient_id, status, payer_type, scheme_portion_cents").eq("id", invoiceId.data).maybeSingle();
  const inv = data as Inv | null;
  if (!inv) notFound();

  const psychologist = me.role === "psychologist";
  const [claimsR, memberR, patientR, lineR, consentR] = await Promise.all([
    sb.from("claims").select("id, status, claimed_cents").eq("invoice_id", inv.id),
    sb.from("medical_aid_members").select("id, scheme, plan, dependant_code, valid_from, valid_to").eq("patient_id", inv.patient_id).order("valid_from", { ascending: false, nullsFirst: false }),
    sb.from("patients").select("first_name, last_name").eq("id", inv.patient_id).maybeSingle(),
    sb.from("invoice_lines").select("tariff_code").eq("invoice_id", inv.id).not("tariff_code", "is", null).limit(1),
    sb.from("consents").select("granted").eq("patient_id", inv.patient_id).eq("purpose", "share_insurer").maybeSingle(),
  ]);
  const back = <Link href={`/app/billing/${inv.id}`}>Back to invoice {inv.number}</Link>;
  if (claimsR.error || memberR.error) {
    return <><PageHeader title="Open a medical aid claim" description={back} /><Notice tone="error">We could not load what is needed for a claim. Please refresh the page.</Notice></>;
  }

  const claimable = ["issued", "part_paid"].includes(inv.status) && ["medical_aid", "split"].includes(inv.payer_type);
  const remaining = claimableCents(inv.scheme_portion_cents, (claimsR.data ?? []) as { id: string; status: string; claimed_cents: number }[]);
  const members = ((memberR.data ?? []) as Member[]).filter((m) => isCurrentMember(m, today));
  const patient = patientR.data as { first_name: string; last_name: string } | null;
  // POPIA: a draft may be prepared, but it cannot be marked submitted until the patient has given share_insurer consent (0032)
  const insurerConsent = consentR.error ? "none" : insurerConsentState(consentR.data as { granted: boolean } | null);
  const tariffGuess = ((lineR.data ?? [])[0] as { tariff_code: string | null } | undefined)?.tariff_code ?? "";
  const label = (m: Member) => `${m.scheme}${m.plan ? `, ${m.plan}` : ""}${m.dependant_code ? ` (dependant ${m.dependant_code})` : ""}`;

  let stop: React.ReactNode = null;
  if (!claimable) stop = <Notice tone="warning">A claim can only be opened on an issued or part paid invoice that the medical aid pays (fully or in part). This invoice is {inv.status.replace("_", " ")} and {PAYER_LABEL[inv.payer_type]?.toLowerCase() ?? inv.payer_type}.</Notice>;
  else if (remaining <= 0) stop = <Notice tone="info">The whole medical aid portion of this invoice is already covered by claims. Reject or correct an existing claim if it needs to change.</Notice>;
  else if (members.length === 0) stop = <Notice tone="warning">This patient has no current medical aid membership. <Link href={`/app/patients/${inv.patient_id}?tab=medical-aid`}>Add or update the member on the patient&apos;s Medical aid tab</Link>, then come back.</Notice>;

  return (
    <>
      <PageHeader title="Open a medical aid claim" description={<>{back}</>} />
      <Card className="mb-6">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-muted">Patient</dt><dd className="font-medium">{patient ? <Link href={`/app/patients/${inv.patient_id}`}>{patient.first_name} {patient.last_name}</Link> : "Unknown patient"}</dd>
          <dt className="text-ink-muted">Invoice</dt><dd className="font-medium">{inv.number}</dd>
          <dt className="text-ink-muted">Medical aid portion</dt><dd className="font-medium">{formatZar(inv.scheme_portion_cents)}</dd>
          <dt className="text-ink-muted">Still to claim</dt><dd className="font-medium">{formatZar(remaining)}</dd>
        </dl>
      </Card>
      <Notice tone="info" title="Manual submission"><p>{MANUAL_SUBMISSION_NOTE}</p></Notice>
      {insurerConsent === "granted" ? (
        <Notice tone="success" title="Permission given"><p>The patient has given permission to share claim information with their medical aid.</p></Notice>
      ) : (
        <Notice tone="warning" title="No permission to share with the medical aid">
          <p>{INSURER_CONSENT_MISSING[insurerConsent]} You can prepare a draft now, but it cannot be marked as submitted until permission is given.</p>
          <p className="mt-2"><Link href={`/app/patients/${inv.patient_id}?tab=forms`}>Open the patient&apos;s Consent &amp; forms tab</Link></p>
        </Notice>
      )}
      {stop ?? (
        <Card>
          <KeepForm action={openClaim} args={[inv.id]} submitLabel="Create draft claim" pendingLabel="Creating…">
            <ClaimFields
              members={members.map((m) => ({ id: m.id, label: label(m) }))}
              initial={{ memberId: members[0].id, amount: formatZarInput(remaining), tariff: TARIFF.test(tariffGuess) ? tariffGuess : "", preauth: "", icd10: [] }}
              canChooseCodes={psychologist}
              maxAmountHint={`At most ${formatZar(remaining)} (what is left of the medical aid portion).`} />
          </KeepForm>
          {!psychologist && <p className="mt-4 text-sm text-ink-muted">The claim is created as a draft without diagnosis codes. The practitioner adds them before it can be marked as submitted.</p>}
        </Card>
      )}
    </>
  );
}
