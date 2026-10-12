"use client";

import { useContext } from "react";
import { Input, Textarea } from "@/components/ui/field";
import { REASON_MAX, REMITTANCE_REF_MAX } from "@/lib/claims/input";
import { FieldErrorContext } from "../billing/keep-form";

// Field groups of the claim action forms. Each reads the server's field error from the surrounding KeepForm.
const useErr = () => { const fe = useContext(FieldErrorContext); return (id: string) => (fe.field === id ? fe.error : undefined); };

/** The reference the scheme or clearing house gave the claim, if any (submit and resubmit). */
export function ClaimRefField() {
  const err = useErr();
  return <Input id="claim_ref" label="Claim reference from the scheme or clearing house (optional)" maxLength={40} autoComplete="off" hint="Add it if you were given one. It is not needed to mark the claim as submitted." error={err("claim_ref")} />;
}

export function ApprovedField({ defaultValue, claimed }: { defaultValue: string; claimed: string }) {
  const err = useErr();
  return <Input id="approved" label="Amount approved by the scheme (rand)" required inputMode="decimal" defaultValue={defaultValue} hint={`Not more than the ${claimed} claimed.`} error={err("approved")} />;
}

export function RejectionFields() {
  const err = useErr();
  return <Textarea id="reason" label="Why was it rejected?" required rows={3} maxLength={REASON_MAX} hint="As stated by the scheme. This is kept with the claim for staff only and is never put in the patient's portal, an email or the audit log." error={err("reason")} />;
}

export function RemittanceFields({ unpaid, unpaidLabel }: { unpaid: string; unpaidLabel: string }) {
  const err = useErr();
  return (
    <div className="grid gap-x-4 sm:grid-cols-2">
      <Input id="amount" label="Amount the scheme paid (rand)" required inputMode="decimal" defaultValue={unpaid} hint={`Still unpaid on this claim: ${unpaidLabel}.`} error={err("amount")} />
      <Input id="ref" label="Remittance reference" required maxLength={REMITTANCE_REF_MAX} autoComplete="off"
             hint="Use the remittance advice number. The same number can be used for several claims. Entering the same number and amount again for this claim does not record the payment twice." error={err("ref")} />
    </div>
  );
}
