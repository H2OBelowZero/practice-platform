import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2 text-base font-medium leading-tight no-underline " +
  "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60";
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-sage-700 text-white hover:bg-sage-800 hover:text-white",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-sunk hover:text-ink",
  quiet: "bg-transparent text-blue-700 hover:bg-blue-100 hover:text-blue-800",
  danger: "bg-danger text-white hover:bg-danger-strong hover:text-white",
};

/** Class string for anything that should look like a button (e.g. a Next Link). */
export const buttonClass = (variant: ButtonVariant = "primary", extra?: string) => cx(BASE, VARIANTS[variant], extra);

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean };

/** `loading` keeps the label, shows a spinner, disables the button and sets aria-busy. */
export function Button({ variant = "primary", loading = false, disabled, className, children, type = "button", ...rest }: Props) {
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, className)} {...rest}>
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function LinkButton({ variant = "primary", className, ...rest }: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return <Link className={buttonClass(variant, className)} {...rest} />;
}
