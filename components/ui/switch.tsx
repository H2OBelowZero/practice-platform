import { cx } from "@/lib/cx";

/**
 * An on/off setting inside a form (a checkbox with role="switch"): submitted as `name=on` when on, absent when off. The real input sits invisibly over
 * the drawn switch, so the keyboard, screen readers and the label all work natively; the state is also written as "On" / "Off" (never colour or position alone).
 * The invisible input cannot draw a focus ring, so the drawn track does (peer-focus-visible: 3px in the focus colour, like every other control).
 * Uncontrolled (`defaultChecked`) needs no JavaScript; pass `checked` + `onChange` from a client component to keep the choice across a failed save.
 */
export function Switch({ id, name, label, hint, defaultChecked, checked, onChange, disabled, className }: {
  id: string; name: string; label: string; hint?: string; defaultChecked?: boolean; checked?: boolean; onChange?: (on: boolean) => void; disabled?: boolean; className?: string;
}) {
  const state = checked === undefined ? { defaultChecked } : { checked, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.checked) };
  return (
    <div className={cx("flex items-start justify-between gap-4 py-4", className)}>
      <div className="max-w-md">
        <label htmlFor={id} className="block font-medium">{label}</label>
        {hint && <p id={`${id}-hint`} className="mt-1 text-sm text-ink-muted">{hint}</p>}
      </div>
      <span className="relative inline-flex min-h-11 shrink-0 items-center gap-2">
        <input id={id} name={name} type="checkbox" role="switch" {...state} disabled={disabled}
               aria-describedby={hint ? `${id}-hint` : undefined}
               className="peer absolute inset-0 z-10 h-full w-full cursor-pointer rounded-full opacity-0 disabled:cursor-not-allowed" />
        <span aria-hidden="true" className={
          "relative h-7 w-12 rounded-full border-2 border-line-strong bg-surface transition-colors motion-reduce:transition-none " +
          "after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-line-strong after:transition-transform motion-reduce:after:transition-none " +
          "peer-checked:border-sage-700 peer-checked:bg-sage-700 peer-checked:after:translate-x-5 peer-checked:after:bg-white peer-disabled:opacity-50 " +
          "peer-focus-visible:outline-3 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-700"} />
        <span aria-hidden="true" className="hidden w-7 text-sm font-medium peer-checked:inline">On</span>
        <span aria-hidden="true" className="w-7 text-sm font-medium peer-checked:hidden">Off</span>
      </span>
    </div>
  );
}
