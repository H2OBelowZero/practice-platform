import Link from "next/link";
import { ageOn, isMinor, patientNo } from "@/lib/patients/age";
import { inviteBlock } from "@/lib/patients/invite";
import type { PatientRecord } from "@/lib/patients/record";
import { sastDateLabel } from "@/lib/time";
import { ActionButton } from "@/components/ui/action-form";
import { Icon } from "@/components/ui/icon";
import { StatusChip } from "@/components/ui/status-chip";
import { invitePatient } from "../actions";

/** Name, number, status, age (with a minor badge) and the portal invitation status with its action. */
export function RecordHeader({ patient: p, today }: { patient: PatientRecord; today: string }) {
  const age = ageOn(p.date_of_birth, today);
  const minor = isMinor(p, today);
  const block = inviteBlock(p, today);
  return (
    <header className="mb-6">
      <p className="mb-1 text-sm"><Link href="/app/patients">Back to patients</Link></p>
      <h1>{p.first_name} {p.last_name}</h1>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-medium">{patientNo(p.patient_number)}</span>
        <StatusChip status={p.status} />
        {age !== null && <span className="rounded-2xl bg-grey-tint px-3 py-1 text-sm font-medium text-grey-ink">Age {age}</span>}
        {minor && <span className="inline-flex items-center gap-1.5 rounded-2xl bg-warn-tint px-3 py-1 text-sm font-medium text-warn-ink"><Icon name="info" />Minor</span>}
      </div>

      <section aria-label="Portal access" className="mt-4 rounded-xl bg-sunk p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="max-w-2xl">
            <p className="font-medium">Patient portal</p>
            {p.user_id ? (
              <p className="text-ink-muted"><Icon name="check" className="mr-1" />This patient has a portal account.</p>
            ) : (
              <>
                <p className="text-ink-muted">{p.portal_invited_at ? <>Invited on {sastDateLabel(p.portal_invited_at)}. They have not registered yet.</> : "Not invited yet."}</p>
                {block && <p className="mt-1 text-sm text-ink-muted">{block}</p>}
              </>
            )}
          </div>
          {!p.user_id && !block && (
            <ActionButton action={invitePatient} args={[p.id]} submitLabel={p.portal_invited_at ? "Send invitation again" : "Invite to portal"} pendingLabel="Sending…" variant="secondary" />
          )}
        </div>
      </section>
    </header>
  );
}
