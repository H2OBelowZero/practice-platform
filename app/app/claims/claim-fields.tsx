"use client";

import { useContext } from "react";
import { Input, Select } from "@/components/ui/field";
import type { Icd10 } from "@/lib/claims/icd10";
import { FieldErrorContext } from "../billing/keep-form";
import { Icd10Picker } from "./icd10-picker";

export type ClaimFieldsInitial = { memberId: string; amount: string; tariff: string; preauth: string; icd10: string[] };

/**
 * The fields of the open-claim and edit-draft forms (inside a KeepForm, which supplies the server's field error). `members` are the patient's
 * current members only. Only the psychologist can choose ICD-10 codes: for anyone else the picker is inert and explains why.
 */
export function ClaimFields({ members, initial, codes, canChooseCodes, maxAmountHint }: {
  members: { id: string; label: string }[]; initial: ClaimFieldsInitial; codes: Icd10[]; canChooseCodes: boolean; maxAmountHint: string;
}) {
  const fe = useContext(FieldErrorContext);
  const err = (id: string) => (fe.field === id ? fe.error : undefined);
  return (
    <>
      <Select id="memberId" label="Medical aid member" required defaultValue={initial.memberId} error={err("memberId")}>
        {members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </Select>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="amount" label="Amount to claim (rand)" required inputMode="decimal" defaultValue={initial.amount} placeholder="600,00" hint={maxAmountHint} error={err("amount")} />
        <Input id="tariff" label="Tariff code" required maxLength={20} defaultValue={initial.tariff} autoComplete="off" hint="Letters and numbers only, for example 86205." error={err("tariff")} />
      </div>
      <Input id="preauth" label="Pre-authorisation reference (optional)" maxLength={40} defaultValue={initial.preauth} autoComplete="off" error={err("preauth")} />
      <Icd10Picker codes={codes} initial={initial.icd10} disabled={!canChooseCodes} error={err("icd10")} />
    </>
  );
}
