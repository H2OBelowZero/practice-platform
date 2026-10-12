"use client";

import { useContext } from "react";
import { Input, Textarea } from "@/components/ui/field";
import { FieldErrorContext } from "../keep-form";

/** Fields of the credit note form; they read the server's field error from the surrounding KeepForm. */
export function CreditFields() {
  const fe = useContext(FieldErrorContext);
  const err = (id: string) => (fe.field === id ? fe.error : undefined);
  return (
    <>
      <Input id="amount" label="Credit amount (rand)" required inputMode="decimal" placeholder="150,00" error={err("amount")} />
      <Textarea id="reason" label="Reason" required rows={2} maxLength={300} error={err("reason")} />
    </>
  );
}
