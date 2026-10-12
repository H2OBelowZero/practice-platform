import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { PURPOSE_INFO, PURPOSE_ORDER, consentView, isPurpose, withdrawalCopy, type ConsentRow } from "@/lib/forms/consent";
import { patientIdSchema } from "@/lib/forms/input";
import { formNotice } from "@/lib/forms/notices";
import { formPeople } from "@/lib/forms/people";
import { getCrisisText } from "@/lib/practice";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate, sastDateLabel } from "@/lib/time";
import { ActionButton, FocusOnMount } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { StatusChip } from "@/components/ui/status-chip";
import { withdrawConsent } from "./actions";

export const metadata = { title: "Privacy and consent" };

type Row = ConsentRow & { patient_id: string };

/**
 * What you have agreed to, per purpose, and how to withdraw it. For a guardian, one block per person they care for (with the forms permission).
 * Withdrawing is a two-step action: the link opens an inline confirmation panel (no JavaScript needed); the button there calls withdrawConsent.
 */
export default async function PortalPrivacy({ searchParams }: { searchParams: Promise<{ notice?: string; w?: string }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  const [people, consents, crisis] = await Promise.all([
    formPeople(sb, me.userId, sastDate(new Date())),
    sb.from("consents").select("patient_id, purpose, granted, granted_at, withdrawn_at, template_version, form_submission_id"),
    getCrisisText(),
  ]);
  const rows = (consents.data ?? []) as Row[];
  const showNames = people.length > 1 || people.some((p) => !p.own);

  // ?w=<patient uuid>:<purpose> opens the confirmation panel for that row; anything malformed is ignored
  const [wPatient, wPurpose] = (sp.w ?? "").split(":");
  const open = patientIdSchema.safeParse(wPatient).success && isPurpose(wPurpose) ? { patient: wPatient, purpose: wPurpose } : null;

  return (
    <>
      <PageHeader title="Privacy and consent" description="What you have agreed to, and how to change your mind."
                  actions={<LinkButton href="/portal/documents" variant="secondary">Documents</LinkButton>} />
      {formNotice(sp.notice) && <Notice tone="success">{formNotice(sp.notice)}</Notice>}
      {consents.error && <Notice tone="error">We could not load your consents. Please refresh the page.</Notice>}
      <p className="mb-8 max-w-2xl text-ink-muted">
        You are asked for each consent separately, and you may withdraw any of them at any time. Withdrawing does not delete your record: the practice must keep
        a record of what you agreed to and when. You give a consent by completing the matching form under <Link href="/portal/documents">Documents</Link>.
      </p>

      {people.length === 0 && <Notice tone="info">There is nothing to show on this account yet.</Notice>}
      {people.map((p) => (
        <section key={p.id} aria-labelledby={`h-${p.id}`} className="mb-10">
          {showNames && <h2 id={`h-${p.id}`} className="mb-4">{p.own ? "Your consents" : `Consents for ${p.first_name}`}</h2>}
          {!showNames && <h2 id={`h-${p.id}`} className="sr-only">Your consents</h2>}
          <ul className="grid list-none gap-4 p-0">
            {PURPOSE_ORDER.map((purpose) => {
              const info = PURPOSE_INFO[purpose];
              const v = consentView(rows.find((r) => r.patient_id === p.id && r.purpose === purpose));
              const confirming = open?.patient === p.id && open.purpose === purpose && v.state === "granted";
              const copy = withdrawalCopy(purpose);
              const where = showNames ? ` for ${p.own ? "yourself" : p.first_name}` : "";
              return (
                <li key={purpose}>
                  <Card>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <h3 className="text-lg">{info.label}</h3>
                      {v.state === "granted" && <StatusChip status="done" label="Given" />}
                      {v.state === "withdrawn" && <StatusChip status="cancelled" label="Withdrawn" />}
                      {v.state === "none" && <StatusChip status="pending" label="Not given" />}
                    </div>
                    <p className="mt-1 text-ink-muted">{info.covers}</p>
                    {v.state === "granted" && (
                      <p className="mt-3">
                        Given{v.at ? ` on ${sastDateLabel(v.at)}` : ""}{v.version !== null ? ` for version ${v.version} of the form` : ""}.
                        {v.submissionId && <> <Link href={`/portal/documents/${v.submissionId}`}>View the form</Link></>}
                      </p>
                    )}
                    {v.state === "withdrawn" && (
                      <p className="mt-3">
                        Withdrawn{v.at ? ` on ${sastDateLabel(v.at)}` : ""}.
                        {v.grantedAt && ` It was given on ${sastDateLabel(v.grantedAt)}${v.version !== null ? ` for version ${v.version} of the form` : ""}.`}
                      </p>
                    )}
                    {v.state === "none" && <p className="mt-3">You have not given this consent.</p>}

                    {v.state === "granted" && !confirming && (
                      <div className="mt-4">
                        <LinkButton href={`/portal/privacy?w=${p.id}:${purpose}#withdraw-panel`} variant="quiet" aria-label={`Withdraw consent: ${info.label}${where}`}>Withdraw consent…</LinkButton>
                      </div>
                    )}
                    {confirming && (
                      <FocusOnMount id="withdraw-panel" className="mt-4 rounded-xl border-2 border-line-strong bg-sunk p-4">
                        <h4 className="mb-2 font-semibold">{copy.title}</h4>
                        {copy.lines.map((l) => <p key={l} className="mb-2">{l}</p>)}
                        <div className="mt-4 flex flex-wrap items-start gap-3">
                          <ActionButton action={withdrawConsent} args={[p.id, purpose]} submitLabel="Yes, withdraw my consent" pendingLabel="Withdrawing…" variant="danger" />
                          <LinkButton href="/portal/privacy" variant="secondary">No, keep it</LinkButton>
                        </div>
                      </FocusOnMount>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section aria-labelledby="rights-h" className="mb-8 max-w-2xl">
        <h2 id="rights-h" className="mb-3">Your information and your rights</h2>
        <p className="mb-3">
          You can ask the practice for a copy of the personal information it holds about you, and ask for anything that is wrong or out of date to be corrected
          or deleted, as the Protection of Personal Information Act (POPIA) and the Promotion of Access to Information Act (PAIA) allow. To do so, tell the practice
          in writing, for example by email or at your next appointment, and ask for the practice&apos;s Information Officer.
        </p>
        <p>If you are not happy with how your information is handled, you may complain to the Information Regulator (inforegulator.org.za).</p>
      </section>

      <section aria-labelledby="help-h" className="max-w-2xl">
        <h2 id="help-h" className="mb-3">If you need support now</h2>
        <p>{crisis}</p>
      </section>
    </>
  );
}
