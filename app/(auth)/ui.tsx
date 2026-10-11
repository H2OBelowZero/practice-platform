"use client";

import { useEffect, useRef, type InputHTMLAttributes } from "react";
import type { FormState } from "./actions";
import { Notice as NoticeBox } from "@/components/ui/notice";
import { Input } from "@/components/ui/field";
import { SubmitButton as Submit } from "@/components/ui/submit-button";

// Thin adapters over the shared UI foundation (components/ui) so the auth pages keep their small API.
// Errors are text + icon, never colour alone, and the error summary takes focus when a submit fails.

export const ERROR_ID = "form-error";

export function FormError({ state }: { state: FormState }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state?.error) ref.current?.focus(); }, [state]); // state is a new object on every submit
  if (!state?.error) return null;
  return <NoticeBox ref={ref} id={ERROR_ID} tone="error" focusable>{state.error}</NoticeBox>;
}

export function Notice({ children }: { children: React.ReactNode }) {
  return <NoticeBox tone="success" title="Note">{children}</NoticeBox>;
}

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { id: string; label: string; hint?: string; invalid?: boolean };

/** `invalid` marks the field and points at the form-level error summary (field-level messages are not used on the auth forms). */
export function Field({ id, label, hint, invalid, ...input }: FieldProps) {
  return <Input id={id} label={label} hint={hint} aria-invalid={invalid || undefined} aria-errormessage={invalid ? ERROR_ID : undefined} {...input} />;
}

export function SubmitButton({ children, pendingLabel }: { children: React.ReactNode; pendingLabel: string }) {
  return <Submit pendingLabel={pendingLabel} className="w-full">{children}</Submit>;
}
