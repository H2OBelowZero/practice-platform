"use client";

import { useContext } from "react";
import { Input } from "@/components/ui/field";
import { FieldErrorContext } from "../../billing/keep-form";

export type MemberValues = { memberId: string; scheme: string; plan: string; member_number: string; dependant_code: string; main_member_name: string; valid_from: string; valid_to: string };
export const EMPTY_MEMBER: MemberValues = { memberId: "", scheme: "", plan: "", member_number: "", dependant_code: "", main_member_name: "", valid_from: "", valid_to: "" };

/** Fields of the add / edit member form (inside a KeepForm, which supplies the server's field error). A member is end-dated, never deleted. */
export function MemberFields({ v }: { v: MemberValues }) {
  const fe = useContext(FieldErrorContext);
  const err = (id: string) => (fe.field === id ? fe.error : undefined);
  return (
    <>
      {v.memberId && <input type="hidden" name="memberId" value={v.memberId} />}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="scheme" label="Medical aid scheme" required maxLength={80} defaultValue={v.scheme} autoComplete="off" placeholder="Discovery" error={err("scheme")} />
        <Input id="plan" label="Plan (optional)" maxLength={80} defaultValue={v.plan} autoComplete="off" error={err("plan")} />
        <Input id="member_number" label="Member number" required minLength={3} maxLength={30} defaultValue={v.member_number} autoComplete="off" hint="3 to 30 letters, numbers, hyphens or spaces." error={err("member_number")} />
        <Input id="dependant_code" label="Dependant code (optional)" maxLength={5} defaultValue={v.dependant_code} autoComplete="off" hint="For example 00 for the main member, 01 for the first dependant." error={err("dependant_code")} />
      </div>
      <Input id="main_member_name" label="Main member's name (optional)" maxLength={100} defaultValue={v.main_member_name} autoComplete="off" hint="Fill this in when the patient is a dependant on someone else's plan." error={err("main_member_name")} />
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="valid_from" label="Valid from (optional)" type="date" defaultValue={v.valid_from} error={err("valid_from")} />
        <Input id="valid_to" label="Valid to (optional)" type="date" defaultValue={v.valid_to} hint="When membership ends, set this date rather than removing the member." error={err("valid_to")} />
      </div>
    </>
  );
}
