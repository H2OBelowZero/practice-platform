import { memberState } from "@/lib/claims/rules";
import { sastDayShort } from "@/lib/time";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FocusOnMount } from "@/components/ui/action-form";
import { Notice } from "@/components/ui/notice";
import { StatusChip } from "@/components/ui/status-chip";
import { KeepForm } from "../../billing/keep-form";
import { saveMember } from "../../claims/actions";
import { EMPTY_MEMBER, MemberFields, type MemberValues } from "./member-fields";
import type { TabContext } from "./tabs";

type Member = { id: string; scheme: string; plan: string | null; member_number: string; dependant_code: string | null; main_member_name: string | null; valid_from: string | null; valid_to: string | null };
const values = (m: Member): MemberValues => ({
  memberId: m.id, scheme: m.scheme, plan: m.plan ?? "", member_number: m.member_number, dependant_code: m.dependant_code ?? "",
  main_member_name: m.main_member_name ?? "", valid_from: m.valid_from ?? "", valid_to: m.valid_to ?? "",
});

/**
 * Medical aid memberships of this patient (psychologist and admin; the bookkeeper and everyone else cannot read them). Add and edit only: a membership
 * that ended is end-dated, never deleted, because claims refer to it. Saving audits the member's id and the names of the fields that changed, never the values.
 */
export async function MedicalAidTab({ patient, sb, query, today }: TabContext) {
  const { data, error } = await sb.from("medical_aid_members")
    .select("id, scheme, plan, member_number, dependant_code, main_member_name, valid_from, valid_to")
    .eq("patient_id", patient.id).order("valid_to", { ascending: false, nullsFirst: true }).order("valid_from", { ascending: false, nullsFirst: false });
  if (error) return <Notice tone="error">We could not load the medical aid details for this patient. Please refresh the page.</Notice>;
  const members = (data ?? []) as Member[];
  const hasCurrent = members.some((m) => memberState(m, today) === "current");
  const wantsMedicalAid = patient.payer === "medical_aid" || patient.payer === "split";
  const here = `/app/patients/${patient.id}?tab=medical-aid`;
  const editing = members.find((m) => m.id === query.edit);

  return (
    <div className="grid max-w-3xl gap-6">
      {wantsMedicalAid && !hasCurrent && (
        <Notice tone="warning" title="Medical aid details needed">
          <p>This patient&apos;s record says the medical aid pays (fully or in part), but there is no current membership. Add the member details below so claims can be opened.</p>
        </Notice>
      )}

      {members.length === 0 ? <p className="text-ink-muted">No medical aid membership has been added for this patient.</p> : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {members.map((m) => (
            <li key={m.id}>
              {editing?.id === m.id ? (
                <FocusOnMount id="member-form" className="rounded-card border-2 border-line-strong bg-sunk p-5">
                  <h3 className="mb-3 text-lg">Edit {m.scheme}</h3>
                  <KeepForm action={saveMember} args={[patient.id]} submitLabel="Save member" pendingLabel="Saving…"><MemberFields v={values(m)} /></KeepForm>
                  <p className="mt-4"><LinkButton href={here} variant="quiet">Cancel</LinkButton></p>
                </FocusOnMount>
              ) : (
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-lg font-semibold">{m.scheme}{m.plan ? `, ${m.plan}` : ""}</p>
                      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
                        <dt className="text-ink-muted">Member number</dt><dd className="font-medium">{m.member_number}</dd>
                        {m.dependant_code && <><dt className="text-ink-muted">Dependant code</dt><dd className="font-medium">{m.dependant_code}</dd></>}
                        {m.main_member_name && <><dt className="text-ink-muted">Main member</dt><dd className="font-medium">{m.main_member_name}</dd></>}
                        <dt className="text-ink-muted">Valid</dt>
                        <dd className="font-medium">{m.valid_from ? `from ${sastDayShort(m.valid_from, true)}` : "from the start"}{m.valid_to ? ` to ${sastDayShort(m.valid_to, true)}` : ", no end date"}</dd>
                      </dl>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <StatusChip status={memberState(m, today)} />
                      <LinkButton href={`${here}&edit=${m.id}#member-form`} variant="secondary" aria-label={`Edit ${m.scheme} membership`}>Edit</LinkButton>
                    </div>
                  </div>
                </Card>
              )}
            </li>
          ))}
        </ul>
      )}

      {!editing && (
      <section aria-labelledby="add-member-h">
        <h3 id="add-member-h" className="mb-3 text-lg">Add a member</h3>
        <Card>
          <KeepForm action={saveMember} args={[patient.id]} submitLabel="Add member" pendingLabel="Adding…"><MemberFields v={EMPTY_MEMBER} /></KeepForm>
        </Card>
        {/* the add form is hidden while one is edited: both would use the same field ids */}
        <p className="mt-3 text-sm text-ink-muted">Members cannot be deleted because claims refer to them. When a membership ends, set its end date.</p>
      </section>
      )}
    </div>
  );
}
