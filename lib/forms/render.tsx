import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { Input, Select, Textarea } from "@/components/ui/field";
import { cx } from "@/lib/cx";
import { sastDateLabel } from "@/lib/time";
import { MAX_LEN, type FormField, type FormSchema } from "./validate";

// The pure form renderer: a template schema in, accessible fields out. No state and no hooks, so it renders on the server (read-only view)
// and inside the client editor alike. The editor owns the values, the errors and the autosave.

export type AnswerValue = string | boolean;
export type Answers = Record<string, AnswerValue | undefined>;
export type ControlKind = "text" | "textarea" | "date" | "select" | "checkbox";

/** Which kind of control a field is drawn as. */
export const controlKind = (f: Pick<FormField, "type">): ControlKind => f.type;

/** The DOM id of a field's control (also what the editor focuses on a validation error). */
export const fieldDomId = (key: string) => `f-${key}`;

/** The intro as paragraphs (blank line between them). */
export const introParagraphs = (intro: string | undefined): string[] => (intro ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/** The first field (in template order) that has an error: where focus goes after a failed submit. */
export const firstErrorKey = (schema: FormSchema, errors: Record<string, string>): string | undefined => schema.fields.find((f) => errors[f.key])?.key;

function CheckboxField({ field, checked, error, onChange }: { field: FormField; checked: boolean; error?: string; onChange: (v: boolean) => void }) {
  const id = fieldDomId(field.key);
  const describedBy = [field.help ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="mb-5">
      <div className="flex items-start gap-3">
        <input type="checkbox" id={id} name={id} checked={checked} onChange={(e) => onChange(e.target.checked)}
               aria-describedby={describedBy} aria-invalid={error ? true : undefined} aria-required={field.required ? true : undefined}
               className="mt-0.5 size-6 shrink-0 accent-sage-700" />
        <label htmlFor={id} className="font-medium">
          {field.label}{field.required && <span aria-hidden="true" className="text-ink-muted"> *</span>}
        </label>
      </div>
      {field.help && <p id={`${id}-hint`} className="mt-1 pl-9 text-sm text-ink-muted">{field.help}</p>}
      {error && (
        <p id={`${id}-error`} className="mt-1.5 flex items-start gap-1.5 pl-9 text-sm font-medium text-danger">
          <Icon name="alert" className="mt-0.5" /><span><span className="sr-only">Error: </span>{error}</span>
        </p>
      )}
    </div>
  );
}

/** One field as the right control, with its label, required marker, help text and error (aria-invalid and aria-describedby come from the UI field components). */
export function FormFieldControl({ field, value, error, onChange }: { field: FormField; value: AnswerValue | undefined; error?: string; onChange: (key: string, v: AnswerValue) => void }) {
  const id = fieldDomId(field.key);
  const common = { id, label: field.label, hint: field.help, error, required: field.required } as const;
  switch (controlKind(field)) {
    case "checkbox":
      return <CheckboxField field={field} checked={value === true} error={error} onChange={(v) => onChange(field.key, v)} />;
    case "textarea":
      return <Textarea {...common} rows={5} maxLength={MAX_LEN.textarea} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(field.key, e.target.value)} />;
    case "select":
      return (
        <Select {...common} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(field.key, e.target.value)}>
          <option value="">Choose…</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      );
    case "date":
      return <Input {...common} type="date" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(field.key, e.target.value)} />;
    default:
      return <Input {...common} type="text" autoComplete="off" maxLength={MAX_LEN.text} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(field.key, e.target.value)} />;
  }
}

/** The intro paragraphs, then every field of the template. `values` is the editor's state; `errors` is one message per field key. */
export function FormRenderer({ schema, values, errors = {}, onChange }: {
  schema: FormSchema; values: Answers; errors?: Record<string, string>; onChange: (key: string, v: AnswerValue) => void;
}) {
  return (
    <div>
      {introParagraphs(schema.intro).length > 0 && (
        <div className="mb-8 max-w-2xl space-y-3 text-ink">
          {introParagraphs(schema.intro).map((p, i) => <p key={i}>{p}</p>)}
        </div>
      )}
      <p className="mb-5 text-sm text-ink-muted"><span aria-hidden="true">* </span>Items marked with a star are required.</p>
      <div className="max-w-2xl">
        {schema.fields.map((f) => <FormFieldControl key={f.key} field={f} value={values[f.key]} error={errors[f.key]} onChange={onChange} />)}
      </div>
    </div>
  );
}

/** How a stored answer reads in a read-only view. */
export function answerText(f: FormField, v: unknown): string | null {
  if (f.type === "checkbox") return v === true ? "Yes" : v === false ? "No" : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  return f.type === "date" ? sastDateLabel(v) : v;
}

/** Read-only answers by field label (completed forms in the portal, the staff view, snapshots). */
export function AnswersView({ schema, answers, className }: { schema: FormSchema; answers: Record<string, unknown>; className?: string }): ReactNode {
  return (
    <dl className={cx("grid max-w-2xl gap-4", className)}>
      {schema.fields.map((f) => {
        const text = answerText(f, Object.hasOwn(answers, f.key) ? answers[f.key] : undefined);
        return (
          <div key={f.key}>
            <dt className="font-medium">{f.label}</dt>
            <dd className={cx("mt-0.5 whitespace-pre-wrap break-words", text === null && "text-ink-muted")}>{text ?? "Not answered"}</dd>
          </div>
        );
      })}
    </dl>
  );
}
