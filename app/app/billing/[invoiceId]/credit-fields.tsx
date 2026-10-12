"use client";

import { useContext } from "react";
import { Input, Textarea } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { FieldErrorContext } from "../keep-form";

const OPTIONS = [
  { value: "scheme", label: "Write off the medical aid shortfall", hint: "The medical aid paid less than its portion and the rest will not be claimed. The patient is not asked to pay it." },
  { value: "patient", label: "Discount or write-off for the patient", hint: "Reduces what the patient owes. It does not change what the medical aid still owes." },
] as const;

/**
 * Fields of the credit note form; they read the server's field error from the surrounding KeepForm.
 * A medical aid / split invoice asks which portion the credit settles (R40); a self-pay invoice has no medical aid portion, so nothing is asked
 * (the server fixes it to the patient's, whatever is submitted).
 */
export function CreditFields({ payer }: { payer: string }) {
  const fe = useContext(FieldErrorContext);
  const err = (id: string) => (fe.field === id ? fe.error : undefined);
  const portionError = err("portion");
  return (
    <>
      {payer !== "self" && (
        <fieldset id="portion" className="mb-5 border-0 p-0" aria-describedby={portionError ? "portion-error" : undefined}>
          <legend className="mb-1 block font-medium">What is this credit for? <span aria-hidden="true" className="text-ink-muted">*</span></legend>
          <div className="grid gap-3">
            {OPTIONS.map((o) => (
              <label key={o.value} className="flex min-h-11 items-start gap-3 rounded-xl border border-line-strong bg-surface p-3">
                <input type="radio" name="portion" value={o.value} required className="mt-1 size-5 shrink-0" />
                <span><span className="block font-medium">{o.label}</span><span className="block text-sm text-ink-muted">{o.hint}</span></span>
              </label>
            ))}
          </div>
          {portionError && (
            <p id="portion-error" className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-danger">
              <Icon name="alert" className="mt-0.5" /><span><span className="sr-only">Error: </span>{portionError}</span>
            </p>
          )}
        </fieldset>
      )}
      <Input id="amount" label="Credit amount (rand)" required inputMode="decimal" placeholder="150,00" error={err("amount")} />
      <Textarea id="reason" label="Reason" required rows={2} maxLength={300} error={err("reason")} />
    </>
  );
}
