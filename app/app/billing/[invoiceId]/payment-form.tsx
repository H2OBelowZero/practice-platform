"use client";

import { useActionState, useState, startTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { FormError } from "@/components/ui/form-error";
import { Notice } from "@/components/ui/notice";
import type { Values } from "@/lib/appointments/types";
import type { PayState } from "@/lib/billing/types";
import { formatZar } from "@/lib/money";

/**
 * Manual payment form (EFT, cash, card machine). Submitted with onSubmit (not the form `action` prop) so React does not clear the fields
 * when the server answers with an error. When the database says the same payment may already be recorded, the form shows a warning
 * and its button becomes "Record anyway", which resends with allowDuplicate. Changing any field withdraws that offer, so a different
 * payment never skips the double-entry check.
 */
export function PaymentForm({ action, invoiceId, outstandingCents, today }: {
  action: (id: string, v: Values) => Promise<PayState>; invoiceId: string; outstandingCents: number; today: string;
}) {
  const [method, setMethod] = useState("eft");
  const [state, run, pending] = useActionState(async (_p: PayState, fd: FormData): Promise<PayState> => {
    const values: Values = {};
    for (const [k, v] of fd.entries()) if (typeof v === "string") values[k] = v;
    return action(invoiceId, values);
  }, null);
  const [withdrawnFor, setWithdrawnFor] = useState<PayState>(null);
  const armed = !!state?.duplicate && withdrawnFor !== state;
  const fe = (id: string) => (state?.field === id && !armed ? state.error : undefined);

  return (
    <form
      onChange={() => { if (state?.duplicate) setWithdrawnFor(state); }}
      onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); startTransition(() => run(fd)); }}
    >
      <FormError message={armed ? null : state?.error} state={state} />
      {armed && <Notice tone="warning" title="This looks like a repeat">{state?.error} If this is a genuine second payment of the same amount, record it anyway.</Notice>}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Select id="method" label="Method" required error={fe("method")} value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="eft">EFT</option><option value="cash">Cash</option><option value="card_machine">Card machine</option>
        </Select>
        <Input id="amount" label="Amount received (rand)" required inputMode="decimal" placeholder="950,00" hint={`Still owed: ${formatZar(outstandingCents)}.`} error={fe("amount")} />
        <Input id="reference" label={method === "cash" ? "Receipt number (optional)" : method === "eft" ? "Bank reference" : "Card slip number"}
               required={method !== "cash"} maxLength={100} error={fe("reference")} />
        <Input id="receivedOn" label="Date received" type="date" required max={today} defaultValue={today} error={fe("receivedOn")} />
      </div>
      {armed && <input type="hidden" name="allowDuplicate" value="true" />}
      <Button type="submit" loading={pending}>{pending ? "Recording…" : armed ? "Record anyway" : "Record payment"}</Button>
    </form>
  );
}
