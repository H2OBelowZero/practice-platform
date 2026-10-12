import Link from "next/link";
import { latestPerKey, templateTitle } from "@/lib/forms/access";
import { PURPOSE_INFO, PURPOSE_ORDER, consentView, type ConsentRow } from "@/lib/forms/consent";
import type { FormSchema } from "@/lib/forms/validate";
import { sastDateLabel } from "@/lib/time";
import { ActionForm } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { StatusChip } from "@/components/ui/status-chip";
import { requestForm } from "./forms/actions";
import type { TabContext } from "./tabs";

type Sub = {
  id: string; status: string; template_version: number; created_at: string; submitted_at: string | null; submitted_by: string | null; return_note: string | null;
  form_templates: { key: string; schema: FormSchema } | null;
};

const ROLE_WORD: Record<string, string> = { patient: "Patient", guardian: "Guardian" };

/** Forms, the consent per purpose, and requesting a form. Everything is read through RLS: an admin does not receive the restricted (health history) submissions at all. */
export async function FormsTab({ patient, role, sb }: TabContext) {
  const [subs, consents, templates] = await Promise.all([
    sb.from("form_submissions").select("id, status, template_version, created_at, submitted_at, submitted_by, return_note, form_templates(key, schema)")
      .eq("patient_id", patient.id).order("created_at", { ascending: false }),
    sb.from("consents").select("purpose, granted, granted_at, withdrawn_at, template_version, form_submission_id").eq("patient_id", patient.id),
    sb.from("form_templates").select("id, key, version, schema").eq("active", true),
  ]);
  if (subs.error || consents.error) return <Notice tone="error">We could not load the forms for this patient. Please refresh the page.</Notice>;
  const rows = (subs.data ?? []) as unknown as Sub[];
  const consentRows = (consents.data ?? []) as ConsentRow[];

  // who submitted: "Patient" / "Guardian" or the staff member's name (on behalf)
  const by = [...new Set(rows.map((r) => r.submitted_by).filter((x): x is string => !!x))];
  const { data: profs } = by.length ? await sb.from("profiles").select("user_id, role, display_name").in("user_id", by) : { data: [] };
  const who = new Map((profs ?? []).map((p) => [p.user_id as string, ROLE_WORD[p.role as string] ?? `Staff: ${(p.display_name as string) || "unnamed"}`]));

  const admin = role === "admin";
  const offer = latestPerKey((templates.data ?? []) as unknown as { id: string; key: string; version: number; schema: FormSchema }[])
    .filter((t) => !(admin && t.schema?.restricted === true)) // the database refuses it for an admin as well
    .sort((a, b) => templateTitle(a).localeCompare(templateTitle(b)));
  const archived = patient.status === "archived";

  return (
    <div className="grid gap-8">
      {admin && <Notice tone="info">The health history form is visible to the psychologist only. You will not see it listed here, and you cannot request it.</Notice>}

      <section aria-labelledby="subs-h">
        <h3 id="subs-h" className="mb-3 text-lg">Forms</h3>
        {rows.length === 0 ? <Notice tone="info">No forms have been requested or completed yet.</Notice> : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Forms for this patient, newest first</caption>
              <thead className="bg-sunk text-sm text-ink-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Form</th>
                  <th scope="col" className="px-4 py-3 font-medium">Version</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Requested</th>
                  <th scope="col" className="px-4 py-3 font-medium">Submitted</th>
                  <th scope="col" className="px-4 py-3 font-medium">Submitted by</th>
                  <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const name = r.form_templates ? templateTitle(r.form_templates) : "Form";
                  return (
                    <tr key={r.id} className="border-t border-line align-top">
                      <td className="px-4 py-3 font-medium">{name}</td>
                      <td className="px-4 py-3">v{r.template_version}</td>
                      <td className="px-4 py-3"><StatusChip status={r.status} label={r.status === "draft" ? "Waiting for patient" : undefined} /></td>
                      <td className="px-4 py-3 whitespace-nowrap">{sastDateLabel(r.created_at)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">{r.submitted_at ? sastDateLabel(r.submitted_at) : "Not yet"}</td>
                      <td className="px-4 py-3">{r.submitted_by ? who.get(r.submitted_by) ?? "Another user" : "Not yet"}</td>
                      <td className="px-4 py-3">
                        {r.status !== "draft"
                          ? <Link href={`/app/patients/${patient.id}/forms/${r.id}`} aria-label={`View ${name}, version ${r.template_version}`}>View</Link>
                          : <span className="text-sm text-ink-muted">Not submitted</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="consent-h">
        <h3 id="consent-h" className="mb-1 text-lg">Consent</h3>
        <p className="mb-3 max-w-2xl text-ink-muted">One row per purpose. A consent is given by submitting the matching form; the patient can withdraw it from their portal.</p>
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Consent by purpose</caption>
            <thead className="bg-sunk text-sm text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Purpose</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Given</th>
                <th scope="col" className="px-4 py-3 font-medium">Withdrawn</th>
                <th scope="col" className="px-4 py-3 font-medium">Form version</th>
                <th scope="col" className="px-4 py-3 font-medium">Form</th>
              </tr>
            </thead>
            <tbody>
              {PURPOSE_ORDER.map((purpose) => {
                const row = consentRows.find((c) => c.purpose === purpose);
                const v = consentView(row);
                return (
                  <tr key={purpose} className="border-t border-line align-top">
                    <th scope="row" className="px-4 py-3 text-left font-medium">{PURPOSE_INFO[purpose].label}</th>
                    <td className="px-4 py-3">
                      {v.state === "granted" && <StatusChip status="done" label="Given" />}
                      {v.state === "withdrawn" && <StatusChip status="cancelled" label="Withdrawn" />}
                      {v.state === "none" && <StatusChip status="pending" label="Not given" />}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{row?.granted_at ? sastDateLabel(row.granted_at) : "Never"}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{row?.withdrawn_at ? sastDateLabel(row.withdrawn_at) : "No"}</td>
                    <td className="px-4 py-3">{row?.template_version != null ? `v${row.template_version}` : "None"}</td>
                    <td className="px-4 py-3">
                      {row?.form_submission_id
                        ? <Link href={`/app/patients/${patient.id}/forms/${row.form_submission_id}`} aria-label={`View the form for ${PURPOSE_INFO[purpose].label}`}>View</Link>
                        : "None"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="request-h">
        <Card className="max-w-2xl">
          <h3 id="request-h" className="mb-2 text-lg">Request a form</h3>
          {archived ? <p className="text-ink-muted">This patient is archived. Restore them on the Administrative tab to request a form.</p> : (
            <>
              <p className="mb-4 text-ink-muted">
                The form appears in the patient&apos;s Documents.
                {patient.comms_prefs?.email === true && patient.email ? " They will also get an email with a link to the portal." : " They will not get an email (no email address, or email is switched off for them)."}
                {!patient.user_id && " They have no portal account yet, so they will see it once they register (invite them from the top of this page)."}
              </p>
              <ActionForm action={requestForm} args={[patient.id]} submitLabel="Request form" pendingLabel="Requesting…">
                <Select id="template" label="Form" required defaultValue="">
                  <option value="" disabled>Choose a form…</option>
                  {offer.map((t) => <option key={t.id} value={t.id}>{templateTitle(t)}</option>)}
                </Select>
              </ActionForm>
            </>
          )}
        </Card>
      </section>
    </div>
  );
}
