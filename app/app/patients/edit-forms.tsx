"use client";

import { useActionState } from "react";
import type { Values } from "@/lib/appointments/types";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";
import { AdminFields, ProfileFields } from "./fields";
import { updateAdministrative, updateProfile, type EditState } from "./actions";

/**
 * Edit forms for a patient record. After a validation failure the server sends back the typed values and one message per field;
 * the form is re-keyed so it refills from them, each failing input gets aria-invalid and its message (via the field components),
 * and the error summary takes focus. Success redirects.
 */
function useEdit(run: (values: Values) => Promise<EditState>) {
  return useActionState(async (_prev: EditState, fd: FormData): Promise<EditState> => {
    const values: Values = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") values[k] = v;
    return run(values);
  }, null);
}

export function ProfileForm({ patientId, initial }: { patientId: string; initial: Values }) {
  const [state, action] = useEdit((v) => updateProfile(patientId, v));
  return (
    <form action={action} key={state?.at ?? 0}>
      <FormError message={state?.error} state={state} />
      <ProfileFields v={state?.values ?? initial} errors={state?.fieldErrors} />
      <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
    </form>
  );
}

export function AdminForm({ patientId, initial, statusEditable }: { patientId: string; initial: Values; statusEditable: boolean }) {
  const [state, action] = useEdit((v) => updateAdministrative(patientId, v));
  return (
    <form action={action} key={state?.at ?? 0}>
      <FormError message={state?.error} state={state} />
      <AdminFields v={state?.values ?? initial} errors={state?.fieldErrors} statusEditable={statusEditable} />
      <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
    </form>
  );
}
