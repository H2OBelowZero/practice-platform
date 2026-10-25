import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-5 py-2 text-base font-medium leading-tight no-underline " +
  "transition-[color,background-color,border-color,box-shadow,transform] duration-200 ease-out active:scale-[0.98] active:duration-75 " +
  "disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-60";
const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-sage-700 text-white shadow-[0_1px_2px_rgb(23_58_47/0.2)] hover:bg-sage-800 hover:text-white hover:shadow-[0_6px_16px_-6px_rgb(23_58_47/0.45)]",
  secondary: "border border-line-strong bg-surface text-ink hover:border-sage-700 hover:bg-sage-100 hover:text-sage-900",
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

/**
 * A plain `<a>` that looks like a button, for a file DOWNLOAD (a CSV export). Never a next/link: Link can prefetch and soft-navigate, which would run the
 * download route (and, for the audit export, write an audit row and read thousands of rows) without anyone clicking. tests/unit/no-link-to-export.test.ts
 * fails the build if a Link or LinkButton points at an /export route.
 */
export function AnchorButton({ variant = "primary", className, ...rest }: ComponentProps<"a"> & { variant?: ButtonVariant }) {
  return <a download className={buttonClass(variant, className)} {...rest} />;
}
