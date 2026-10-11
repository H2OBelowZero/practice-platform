"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { Values } from "@/lib/appointments/types";
import { REASON_TEXT } from "@/lib/patients/duplicates";
import { patientNo } from "@/lib/patients/age";
import { FocusOnMount } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { FormError } from "@/components/ui/form-error";
import { Notice } from "@/components/ui/notice";
import { StatusChip } from "@/components/ui/status-chip";
import { SubmitButton } from "@/components/ui/submit-button";
import { AdminFields, ProfileFields } from "../fields";
import { createPatient, type CreateState } from "../actions";

const DEFAULTS: Values = { language: "en", comms_email: "on", payer: "self", status: "prospect" };

/**
 * Creates a patient. If the server finds possible duplicates it sends the form back with the matches listed; the person then
 * ticks "create anyway" and submits again. The form is re-keyed on every answer so the fields refill from what was typed.
 */
export function NewPatientForm() {
  const [state, run] = useActionState(
    async (_prev: CreateState, fd: FormData): Promise<CreateState> => {
      const values: Values = {};
      for (const [k, v] of fd.entries()) if (typeof v === "string") values[k] = v;
      return createPatient(values);
    },
    null,
  );
  const v = state?.values ?? DEFAULTS;
  const errors = state?.fieldErrors ?? {};
  const dups = state?.duplicates ?? [];

  return (
    <form action={run} key={state?.at ?? 0}>
      <FormError message={state?.error} state={state} />
      {dups.length > 0 && (
        <FocusOnMount id="duplicates">
          <Notice tone="warning" title="This patient may already exist">
            <p>These records look similar. Please check them before adding another.</p>
            <ul className="mt-2 grid list-disc gap-2 pl-5">
              {dups.map((d) => (
                <li key={d.id}>
                  <Link href={`/app/patients/${d.id}`} target="_blank" rel="noreferrer">{d.first_name} {d.last_name} ({patientNo(d.patient_number)})</Link>{" "}
                  <StatusChip status={d.status} className="align-middle" />
                  <span className="block text-sm">Matches on {d.reasons.map((r) => REASON_TEXT[r]).join(" and ")}. Opens in a new tab.</span>
                </li>
              ))}
            </ul>
          </Notice>
          <div className="mb-6 flex items-start gap-3">
            <input id="confirmDuplicate" name="confirmDuplicate" type="checkbox" required className="mt-1 h-6 w-6 shrink-0 accent-sage-700" />
            <label htmlFor="confirmDuplicate" className="font-medium">
              Create anyway
              <span className="block text-sm font-normal text-ink-muted">I have checked the records above and this is a different person.</span>
            </label>
          </div>
        </FocusOnMount>
      )}

      <Card className="mb-6">
        <h2 className="mb-4">Who is this?</h2>
        <ProfileFields v={v} errors={errors} />
      </Card>
      <Card className="mb-6">
        <h2 className="mb-4">Administrative details</h2>
        <AdminFields v={v} errors={errors} />
      </Card>
      <SubmitButton pendingLabel="Saving…">{dups.length > 0 ? "Create patient anyway" : "Create patient"}</SubmitButton>
    </form>
  );
}
