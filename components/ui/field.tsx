import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "./icon";

export type ControlAria = { id: string; "aria-describedby"?: string; "aria-invalid"?: true; "aria-required"?: true };

type FieldProps = { id: string; label: string; hint?: string; error?: string; required?: boolean; children: (aria: ControlAria) => ReactNode };

/**
 * Label + hint + error around any control. The control receives id, aria-describedby (hint and error ids) and aria-invalid.
 * Errors are text with an icon, never colour alone.
 */
export function Field({ id, label, hint, error, required, children }: FieldProps) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="mb-5">
      <label htmlFor={id} className="mb-1 block font-medium">
        {label}{required && <span aria-hidden="true" className="text-ink-muted"> *</span>}
      </label>
      {hint && <p id={`${id}-hint`} className="mb-1.5 text-sm text-ink-muted">{hint}</p>}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, "aria-required": required ? true : undefined })}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-danger">
          <Icon name="alert" className="mt-0.5" /><span><span className="sr-only">Error: </span>{error}</span>
        </p>
      )}
    </div>
  );
}

const CONTROL =
  "block min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 py-2 text-base text-ink placeholder:text-ink-muted " +
  "transition-[border-color,box-shadow] duration-200 hover:border-sage-700 focus:border-sage-700 focus:shadow-[0_0_0_4px_rgb(36_81_63/0.1)] " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:border-2 disabled:bg-sunk disabled:text-ink-muted";

type Common = { id: string; label: string; hint?: string; error?: string };

export function Input({ id, label, hint, error, className, required, ...rest }: Common & Omit<InputHTMLAttributes<HTMLInputElement>, "id">) {
  return <Field id={id} label={label} hint={hint} error={error} required={required}>
    {(aria) => <input name={id} required={required} className={cx(CONTROL, className)} {...aria} {...rest} />}
  </Field>;
}

export function Select({ id, label, hint, error, className, required, children, ...rest }: Common & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id">) {
  return <Field id={id} label={label} hint={hint} error={error} required={required}>
    {(aria) => <select name={id} required={required} className={cx(CONTROL, className)} {...aria} {...rest}>{children}</select>}
  </Field>;
}

export function Textarea({ id, label, hint, error, className, required, rows = 4, ...rest }: Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">) {
  return <Field id={id} label={label} hint={hint} error={error} required={required}>
    {(aria) => <textarea name={id} rows={rows} required={required} className={cx(CONTROL, className)} {...aria} {...rest} />}
  </Field>;
}
