"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/appointments/types";
import { FormError } from "./form-error";

/**
 * Time buttons that each call `action(id, startIso)` when pressed (one tap/Enter, no separate submit step).
 * Used by the patient and staff reschedule pages. Server actions validate the instant again, and the database is the authority.
 */
export function SlotPicker({ action, id, slots, legend }: {
  action: (id: string, startIso: string) => Promise<ActionState>; id: string; slots: { iso: string; label: string }[]; legend: string;
}) {
  const [state, run] = useActionState(async (_prev: ActionState, fd: FormData): Promise<ActionState> => action(id, String(fd.get("start") ?? "")), null);
  return (
    <form action={run}>
      <FormError message={state?.error} state={state} />
      <fieldset>
        <legend className="sr-only">{legend}</legend>
        <div className="flex flex-wrap gap-3">
          {slots.map((s) => (
            <button key={s.iso} type="submit" name="start" value={s.iso}
                    className="min-h-11 min-w-24 rounded-xl border border-line-strong bg-surface px-4 py-2 text-base font-medium tabular-nums transition-colors duration-150 hover:border-sage-700 hover:bg-sage-100">
              {s.label}
            </button>
          ))}
        </div>
      </fieldset>
    </form>
  );
}
