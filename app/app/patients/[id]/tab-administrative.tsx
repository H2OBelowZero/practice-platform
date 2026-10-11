import { ActionButton, ActionForm, FocusOnMount } from "@/components/ui/action-form";
import { LinkButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { adminValues, AdminFields } from "../fields";
import { archivePatient, restorePatient, updateAdministrative } from "../actions";
import type { TabContext } from "./tabs";

/** Emergency contact, referral, payer, status, and archive / restore. There is no delete: a record is archived, never removed. */
export function AdministrativeTab({ patient, query }: TabContext) {
  const archived = patient.status === "archived";
  const here = `/app/patients/${patient.id}?tab=administrative`;
  const confirming = query.confirm === (archived ? "restore" : "archive");

  return (
    <div className="grid max-w-3xl gap-6">
      <Card>
        <ActionForm action={updateAdministrative} args={[patient.id]} submitLabel="Save changes" pendingLabel="Saving…">
          <AdminFields v={adminValues(patient)} statusEditable={!archived} />
        </ActionForm>
      </Card>

      <Card>
        <h3 className="mb-2 text-lg">{archived ? "Restore this patient" : "Archive this patient"}</h3>
        {archived ? (
          <p className="mb-4 text-ink-muted">This patient is archived. They no longer show in the default patient list. Restoring puts them back.</p>
        ) : (
          <p className="mb-4 text-ink-muted">Archiving hides the patient from the default list and stops new portal invitations. Nothing is deleted: appointments, notes, forms and invoices are all kept and can still be opened.</p>
        )}
        {!confirming ? (
          <LinkButton href={`${here}&confirm=${archived ? "restore" : "archive"}#confirm-panel`} variant="secondary">{archived ? "Restore patient…" : "Archive patient…"}</LinkButton>
        ) : (
          <FocusOnMount id="confirm-panel" className="rounded-xl border-2 border-line-strong bg-sunk p-4">
            {archived ? (
              <>
                <h4 className="mb-2 font-semibold">Restore this patient?</h4>
                <ActionForm action={restorePatient} args={[patient.id]} submitLabel="Yes, restore" pendingLabel="Restoring…">
                  <Select id="status" label="Restore as" defaultValue="active">
                    <option value="active">Active</option>
                    <option value="prospect">Prospect</option>
                  </Select>
                </ActionForm>
              </>
            ) : (
              <>
                <h4 className="mb-2 font-semibold">Archive this patient?</h4>
                <p className="mb-4">They will leave the default patient list. You can restore them at any time.</p>
                <ActionButton action={archivePatient} args={[patient.id]} submitLabel="Yes, archive" pendingLabel="Archiving…" variant="danger" />
              </>
            )}
            <p className="mt-4"><LinkButton href={here} variant="quiet">No, keep things as they are</LinkButton></p>
          </FocusOnMount>
        )}
      </Card>
    </div>
  );
}
