"use client";

import { useActionState } from "react";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";
import { bookAppointment, type BookState } from "./actions";

/** Step 4: terms checkbox + "Confirm booking". The checkbox is required here and again in the server action. */
export function ConfirmForm({ typeId, startIso }: { typeId: string; startIso: string }) {
  const [state, action] = useActionState(
    async (_prev: BookState, fd: FormData): Promise<BookState> => bookAppointment({ typeId, startIso, acceptedTerms: fd.get("acceptedTerms") === "on" }),
    null,
  );
  return (
    <form action={action}>
      <FormError message={state?.error} state={state} />
      <div className="mb-6 flex items-start gap-3">
        <input id="acceptedTerms" name="acceptedTerms" type="checkbox" required className="mt-1 h-6 w-6 shrink-0 accent-sage-700" />
        <label htmlFor="acceptedTerms" className="font-medium">I accept the booking and cancellation terms</label>
      </div>
      <SubmitButton pendingLabel="Booking…">Confirm booking</SubmitButton>
    </form>
  );
}
