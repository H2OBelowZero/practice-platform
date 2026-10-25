import Link from "next/link";
import { notFound } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { PAYER_LABEL, ROLE_LABEL } from "@/lib/billing/list";
import { portionSummary } from "@/lib/billing/portions";
import { uuid } from "@/lib/claims/input";
import { claimableCents, claimActions, claimBasisCents, INSURER_CONSENT_MISSING, insurerConsentState, memberState, paidShort, submitReadiness, unpaidCents } from "@/lib/claims/rules";
import { claimEventDetail, claimEventText, claimNotice, MANUAL_SUBMISSION_NOTE, timelineEvents } from "@/lib/claims/view";
import { formatZar, formatZarInput } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel, sastDayShort, sastTime } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { KeepForm } from "../../billing/keep-form";
import { markAccepted, markRejected, markSubmitted, recordRemittance, resubmit, returnToDraft, updateClaim } from "../actions";
import { ApprovedField, ClaimRefField, RejectionFields, RemittanceFields } from "../action-fields";
import { ClaimFields } from "../claim-fields";

// The title never carries a patient's name, a code or a reference (it shows in browser history and tabs).
export const metadata = { title: "Claim" };

type Claim = {
  id: string; invoice_id: string; member_id: string; status: string; claimed_cents: number; approved_cents: number | null;
  tariff_code: string | null; preauth_ref: string | null; claim_ref: string | null; icd10_codes: string[] | null;
  rejection_reason: string | null; submitted_at: string | null; created_at: string;
};
type Inv = {
  id: string; number: string; patient_id: string; status: string; payer_type: string; total_cents: number; scheme_portion_cents: number; patient_portion_cents: number;
};
type Member = { id: string; scheme: string; plan: string | null; member_number: string; dependant_code: string | null; main_member_name: string | null; valid_from: string | null; valid_to: string | null };
type Ev = { id: number; event: string; from_status: string | null; to_status: string | null; detail: unknown; actor: string | null; at: string };

const CLAIM_COLS = "id, invoice_id, member_id, status, claimed_cents, approved_cents, tariff_code, preauth_ref, claim_ref, icd10_codes, rejection_reason, submitted_at, created_at";
const day = (d: string) => sastDayShort(d, true);

/**
 * One medical aid claim. Psychologist and admin only (everyone else, including the bookkeeper, gets a 404; the bookkeeper sees claim amounts and status
 * through the invoice page). Every load is audited (claim.view, ids only) before anything is shown, fail-closed like note.view: the claim holds ICD-10
 * codes, which are clinical information, so it must not be read unrecorded. Actions are offered by status (lib/claims/rules claimActions); each one is
 * checked again by its server action and by the database.
 */
export default async function ClaimPage({ params, searchParams }: { params: Promise<{ claimId: string }>; searchParams: Promise<{ notice?: string }> }) {
  const me = await requireRole(["psychologist", "admin"]);
  const id = uuid.safeParse((await params).claimId);
  if (!id.success) notFound();
  const sp = await searchParams;
  const today = sastDate(new Date());
  const psychologist = me.role === "psychologist";

  const sb = await supabaseServer();
  const { data } = await sb.from("claims").select(CLAIM_COLS).eq("id", id.data).maybeSingle();
  const claim = data as Claim | null;
  if (!claim) notFound();
  const { data: invData } = await sb.from("invoices").select("id, number, patient_id, status, payer_type, total_cents, scheme_portion_cents, patient_portion_cents").eq("id", claim.invoice_id).maybeSingle();
  const inv = invData as Inv | null;
  if (!inv) notFound();
  await audit("claim.view", "claims", claim.id, { invoice_id: claim.invoice_id, patient_id: inv.patient_id });

  const codes = claim.icd10_codes ?? [];
  const draft = claim.status === "draft";
  const actions = claimActions(claim.status, { approvedCents: claim.approved_cents });
  const [membersR, patientR, eventsR, cpR, creditsR, paysR, siblingsR, codeListR, consentR] = await Promise.all([
    sb.from("medical_aid_members").select("id, scheme, plan, member_number, dependant_code, main_member_name, valid_from, valid_to").eq("patient_id", inv.patient_id),
    sb.from("patients").select("first_name, last_name").eq("id", inv.patient_id).maybeSingle(),
    sb.from("claim_events").select("id, event, from_status, to_status, detail, actor, at").eq("claim_id", claim.id).order("id"),
    sb.from("claim_payments").select("amount_cents").eq("claim_id", claim.id),
    sb.from("credit_notes").select("portion, amount_cents").eq("invoice_id", inv.id), // reason / created_by are not granted on the table (0018)
    sb.from("payments").select("method, amount_cents").eq("invoice_id", inv.id).eq("status", "succeeded"),
    sb.from("claims").select("id, status, claimed_cents").eq("invoice_id", inv.id),
    // only the descriptions of this claim's codes; the picker searches the rest on the server
    codes.length ? sb.from("icd10_codes").select("code, description").in("code", codes).order("code") : Promise.resolve({ data: [], error: null }),
    // the patient's permission to share claim information with the scheme (POPIA; the database refuses a submission without it, 0032)
    sb.from("consents").select("granted, granted_at").eq("patient_id", inv.patient_id).eq("purpose", "share_insurer").maybeSingle(),
  ]);
  const loadFailed = !!(membersR.error || eventsR.error || cpR.error || creditsR.error || paysR.error || siblingsR.error || codeListR.error || consentR.error);

  const members = (membersR.data ?? []) as Member[];
  const member = members.find((m) => m.id === claim.member_id) ?? null;
  const memberIsCurrent = !!member && memberState(member, today) === "current";
  const patient = patientR.data as { first_name: string; last_name: string } | null;
  const events = (eventsR.data ?? []) as Ev[];
  const remitted = ((cpR.data ?? []) as { amount_cents: number }[]).reduce((s, r) => s + Number(r.amount_cents), 0);
  const basis = claimBasisCents(claim); // approved once there is an approved amount, else claimed (the basis the database caps remittances at)
  const unpaid = unpaidCents(basis, remitted);
  const sum = portionSummary({
    status: inv.status, totalCents: inv.total_cents, schemeCents: inv.scheme_portion_cents, patientCents: inv.patient_portion_cents,
    credits: ((creditsR.data ?? []) as { portion: string; amount_cents: number }[]).map((c) => ({ portion: c.portion, amountCents: c.amount_cents })),
    payments: ((paysR.data ?? []) as { method: string; amount_cents: number }[]).map((p) => ({ method: p.method, amountCents: p.amount_cents })),
  });
  const remainingToClaim = claimableCents(inv.scheme_portion_cents, (siblingsR.data ?? []) as { id: string; status: string; claimed_cents: number }[], claim.id);
  const codeList = (codeListR.data ?? []) as { code: string; description: string }[];
  const consentRow = consentR.data as { granted: boolean; granted_at: string | null } | null;
  const insurerConsent = consentR.error ? "none" : insurerConsentState(consentRow); // a failed read never counts as consent
  const ready = submitReadiness({ icdCount: codes.length, memberCurrent: memberIsCurrent, claimedCents: claim.claimed_cents, role: me.role, insurerConsent });
  const notice = claimNotice(sp.notice);

  // who did each step: role and name
  const actorIds = [...new Set(events.map((e) => e.actor).filter((x): x is string => !!x))];
  const { data: profs } = actorIds.length ? await sb.from("profiles").select("user_id, role, display_name").in("user_id", actorIds) : { data: [] };
  const actorOf = new Map((profs ?? []).map((p) => [p.user_id as string, `${(p.display_name as string | null) || "Unnamed user"} (${ROLE_LABEL[p.role as string] ?? "Staff"})`]));

  const memberLabel = (m: Member) => `${m.scheme}${m.plan ? `, ${m.plan}` : ""}${m.dependant_code ? ` (dependant ${m.dependant_code})` : ""}${memberState(m, today) === "current" ? "" : memberState(m, today) === "expired" ? " - expired" : " - not started yet"}`;
  const timeline = timelineEvents(events).map((e) => ({ e, text: claimEventText(e) })).filter((x): x is { e: Ev; text: string } => x.text !== null);

  return (
    <>
      <PageHeader title={`Claim for invoice ${inv.number}`} description={<Link href="/app/claims">Back to claims</Link>} />
      {notice && <Notice tone="success">{notice}</Notice>}
      {loadFailed && <Notice tone="error">Some of this claim could not be loaded. Please refresh the page before relying on it.</Notice>}
      <Notice tone="info" title="Manual submission"><p>{MANUAL_SUBMISSION_NOTE}</p></Notice>

      <Card className="mb-6">
        <div className="mb-5 flex flex-wrap items-center gap-2"><StatusChip status={claim.status} />{claim.submitted_at && <span className="text-sm text-ink-muted">Submitted {day(sastDate(claim.submitted_at))}</span>}</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-muted">Patient</dt><dd className="font-medium">{patient ? <Link href={`/app/patients/${inv.patient_id}`}>{patient.first_name} {patient.last_name}</Link> : "Unknown patient"}</dd>
          <dt className="text-ink-muted">Invoice</dt><dd className="font-medium"><Link href={`/app/billing/${inv.id}`}>{inv.number}</Link> · {PAYER_LABEL[inv.payer_type] ?? inv.payer_type}</dd>
          <dt className="text-ink-muted">Medical aid</dt>
          <dd className="font-medium">
            {member ? <>{member.scheme}{member.plan ? `, ${member.plan}` : ""}<span className="block font-normal">Member number {member.member_number}{member.dependant_code ? `, dependant ${member.dependant_code}` : ""}{member.main_member_name ? `, main member ${member.main_member_name}` : ""}</span>
              <span className="mt-1 block"><StatusChip status={memberState(member, today)} /></span></> : "Member not found"}
          </dd>
          <dt className="text-ink-muted">Tariff code</dt><dd className="font-medium">{claim.tariff_code ?? <span className="font-normal text-ink-muted">None</span>}</dd>
          <dt className="text-ink-muted">Pre-authorisation</dt><dd className="font-medium">{claim.preauth_ref ?? <span className="font-normal text-ink-muted">None</span>}</dd>
          <dt className="text-ink-muted">Claim reference</dt><dd className="font-medium">{claim.claim_ref ?? <span className="font-normal text-ink-muted">None yet</span>}</dd>
        </dl>
      </Card>

      <section aria-labelledby="consent-h" className="mb-6">
        <h2 id="consent-h" className="mb-4">Permission to share with the medical aid</h2>
        {insurerConsent === "granted" ? (
          <Notice tone="success" title="Permission given">
            <p>The patient has given permission to share claim information with their medical aid{consentRow?.granted_at ? ` (${day(sastDate(consentRow.granted_at))})` : ""}.</p>
          </Notice>
        ) : (
          <Notice tone="warning" title="This claim cannot be marked as submitted">
            <p>{INSURER_CONSENT_MISSING[insurerConsent]}</p>
            <p className="mt-2"><Link href={`/app/patients/${inv.patient_id}?tab=forms`}>Open the patient&apos;s Consent &amp; forms tab</Link></p>
          </Notice>
        )}
      </section>

      <section aria-labelledby="amounts-h" className="mb-6">
        <h2 id="amounts-h" className="mb-4">Amounts</h2>
        <Card>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2">
            <dt>Claimed from the scheme</dt><dd className="text-right font-medium">{formatZar(claim.claimed_cents)}</dd>
            {claim.approved_cents !== null && <><dt>Approved by the scheme</dt><dd className="text-right font-medium">{formatZar(claim.approved_cents)}</dd></>}
            <dt>Paid by the scheme so far</dt><dd className="text-right font-medium">{formatZar(remitted)}</dd>
            <dt className="font-semibold">Scheme owes</dt><dd className="text-right font-semibold">{["draft", "rejected"].includes(claim.status) ? "-" : formatZar(unpaid)}</dd>
            <dt className="font-semibold">Patient owes</dt><dd className="text-right font-semibold">{sum.perPortion ? formatZar(sum.perPortion.patientCents) : "-"}</dd>
          </dl>
          <p className="mt-3 text-sm text-ink-muted">The patient portion is what the patient still owes on the invoice after their own payments and credit notes. Whatever the scheme does not pay stays on the invoice until it is paid or written off with a credit note; it is not claimed again from the scheme.</p>
          {paidShort(claim, remitted) && <p className="mt-2 font-medium">The scheme paid less than claimed. Write off the shortfall with a credit note (medical aid shortfall) on the invoice if you will not recover it.</p>}
        </Card>
      </section>

      <section aria-labelledby="dx-h" className="mb-6">
        <h2 id="dx-h" className="mb-1">Diagnosis codes</h2>
        <p className="mb-3"><span className="rounded-2xl bg-grey-tint px-2 py-0.5 text-xs font-medium text-grey-ink">Clinical information</span></p>
        {codes.length === 0 ? <p className="text-ink-muted">No diagnosis codes have been added.{!psychologist && draft ? " Diagnosis codes are added by the practitioner." : ""}</p> : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {codes.map((c) => <li key={c}><span className="font-medium">{c}</span><span className="text-ink-muted"> · {codeList.find((x) => x.code === c)?.description ?? ""}</span></li>)}
          </ul>
        )}
      </section>

      {claim.status === "rejected" && claim.rejection_reason && (
        <Notice tone="warning" title="Rejected by the scheme"><p>{claim.rejection_reason}</p></Notice>
      )}

      {actions.includes("edit") && (
        <section aria-labelledby="edit-h" className="mb-6">
          <h2 id="edit-h" className="mb-4">Edit the draft</h2>
          <Card>
            <KeepForm action={updateClaim} args={[claim.id]} submitLabel="Save edits" pendingLabel="Saving…">
              <ClaimFields
                members={members.filter((m) => memberState(m, today) === "current" || m.id === claim.member_id).map((m) => ({ id: m.id, label: memberLabel(m) }))}
                initial={{ memberId: claim.member_id, amount: formatZarInput(claim.claimed_cents), tariff: claim.tariff_code ?? "", preauth: claim.preauth_ref ?? "", icd10: codes.map((code) => ({ code, description: codeList.find((x) => x.code === code)?.description ?? "" })) }}
                canChooseCodes={psychologist}
                maxAmountHint={`At most ${formatZar(remainingToClaim)} (what is left of the medical aid portion).`} />
            </KeepForm>
          </Card>
        </section>
      )}

      {(actions.includes("submit") || actions.includes("resubmit")) && (
        <section aria-labelledby="submit-h" className="mb-6">
          <h2 id="submit-h" className="mb-4">{draft ? "Mark as submitted" : "Submit again"}</h2>
          <Card>
            {!ready.ok ? (
              <Notice tone="warning" title="Not ready to be marked as submitted">
                <ul className="m-0 list-disc pl-5">{ready.missing.map((m) => <li key={m}>{m}</li>)}</ul>
              </Notice>
            ) : (
              <>
                <p className="mb-4 text-ink-muted">{draft ? "Send the claim to the scheme or clearing house first, then mark it as submitted here." : "The claim goes back to the scheme as it is. To change the amount, codes or tariff first, return it to draft instead."}</p>
                <KeepForm action={draft ? markSubmitted : resubmit} args={[claim.id]} submitLabel={draft ? "Mark as submitted" : "Resubmit the claim"} pendingLabel="Saving…"
                  confirm={{ title: draft ? "Mark this claim as submitted?" : "Resubmit this claim?", yes: draft ? "Yes, it has been submitted" : "Yes, resubmit",
                    body: <p>{draft ? "After this the amount, codes and tariff are frozen. Only do this once the claim has really been sent to the scheme or clearing house." : "Only do this once the claim has really been sent to the scheme or clearing house again."}</p> }}>
                  <ClaimRefField />
                </KeepForm>
              </>
            )}
          </Card>
        </section>
      )}

      {actions.includes("accept") && (
        <section aria-labelledby="accept-h" className="mb-6">
          <h2 id="accept-h" className="mb-4">The scheme accepted the claim</h2>
          <Card>
            {claim.status === "part_paid" && <p className="mb-4 text-ink-muted">The scheme has already paid {formatZar(remitted)}. Record what it approved: if that is no more than what was paid, the claim becomes paid.</p>}
            <KeepForm action={markAccepted} args={[claim.id]} submitLabel="Mark as accepted" pendingLabel="Saving…"
              confirm={{ title: "Mark this claim as accepted?", yes: "Yes, mark as accepted", body: <p>This records the approved amount. Payment is recorded separately, when the scheme pays.</p> }}>
              <ApprovedField defaultValue={formatZarInput(claim.claimed_cents)} claimed={formatZar(claim.claimed_cents)} />
            </KeepForm>
          </Card>
        </section>
      )}

      {actions.includes("reject") && (
        <section aria-labelledby="reject-h" className="mb-6">
          <h2 id="reject-h" className="mb-4">The scheme rejected the claim</h2>
          <Card>
            <KeepForm action={markRejected} args={[claim.id]} submitLabel="Mark as rejected" pendingLabel="Saving…" variant="secondary"
              confirm={{ title: "Mark this claim as rejected?", yes: "Yes, mark as rejected", variant: "danger", body: <p>A follow-up task is added for the practice. You can then return the claim to draft to correct it, or resubmit it as it is.</p> }}>
              <RejectionFields />
            </KeepForm>
          </Card>
        </section>
      )}

      {actions.includes("reopen") && (
        <section aria-labelledby="reopen-h" className="mb-6">
          <h2 id="reopen-h" className="mb-4">Correct and submit again</h2>
          <Card>
            <p className="mb-4 text-ink-muted">Return the claim to draft to change the amount, diagnosis codes or tariff code, then mark it as submitted again. The history stays on the timeline below.</p>
            <KeepForm action={returnToDraft} args={[claim.id]} submitLabel="Return to draft for correction" pendingLabel="Saving…" variant="secondary"
              confirm={{ title: "Return this claim to draft?", yes: "Yes, return to draft", body: <p>The claim can then be edited. It is not sent anywhere until you mark it as submitted again.</p> }} />
          </Card>
        </section>
      )}

      {actions.includes("remit") && (
        <section aria-labelledby="remit-h" className="mb-6">
          <h2 id="remit-h" className="mb-4">Record a scheme payment</h2>
          <Card>
            <p className="mb-4 text-ink-muted">Record each payment the scheme makes, using the remittance advice. The amount goes against the invoice. Once the scheme has paid what it will, the invoice&apos;s remaining balance is the patient&apos;s responsibility: it stays payable by the patient (it is not claimed from the scheme again).</p>
            <KeepForm action={recordRemittance} args={[claim.id]} submitLabel="Record scheme payment" pendingLabel="Recording…"
              confirm={{ title: "Record this scheme payment?", yes: "Yes, record the payment", body: <p>The payment is added to the invoice and cannot be changed or removed afterwards.</p> }}>
              <RemittanceFields unpaid={formatZarInput(unpaid)} unpaidLabel={formatZar(unpaid)} />
            </KeepForm>
          </Card>
        </section>
      )}

      <section aria-labelledby="timeline-h">
        <h2 id="timeline-h" className="mb-4">Timeline</h2>
        {timeline.length === 0 ? <p className="text-ink-muted">Nothing has been recorded yet.</p> : (
          <ol className="m-0 grid list-none gap-3 p-0">
            {timeline.map(({ e, text }) => {
              const more = claimEventDetail(e);
              return (
                <li key={e.id} className="rounded-xl border border-line bg-surface p-4">
                  <p className="font-medium">{text}</p>
                  {more && <p>{more}</p>}
                  <p className="text-sm text-ink-muted">{e.actor ? (actorOf.get(e.actor) ?? "Another user") : "System"} · {sastDateLabel(e.at)} at {sastTime(e.at)} (SAST)</p>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}
