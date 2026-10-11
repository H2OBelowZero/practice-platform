"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonVariant } from "./button";

/** Submit button for server-action forms: shows `pendingLabel` and a spinner while the form is submitting. */
export function SubmitButton({ children, pendingLabel, variant = "primary", className }: {
  children: React.ReactNode; pendingLabel?: string; variant?: ButtonVariant; className?: string;
}) {
  const { pending } = useFormStatus();
  return <Button type="submit" variant={variant} loading={pending} className={className}>{pending && pendingLabel ? pendingLabel : children}</Button>;
}
