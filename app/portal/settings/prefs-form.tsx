"use client";

import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/appointments/types";
import type { Prefs } from "@/lib/portal/prefs";
import { FormError } from "@/components/ui/form-error";
import { SubmitButton } from "@/components/ui/submit-button";
import { Switch } from "@/components/ui/switch";
import { updatePrefs } from "./actions";

/**
 * The two reminder switches. The choices live in component state, so after a failed save the person still sees what they chose (a plain form would
 * be reset to the stored values and look as if the save had worked). Success redirects, which reloads the stored values.
 */
export function PrefsForm({ initial, smsHint }: { initial: Prefs; smsHint: string }) {
  const [email, setEmail] = useState(initial.email);
  const [sms, setSms] = useState(initial.sms);
  const [state, run] = useActionState(
    async (_prev: ActionState, fd: FormData): Promise<ActionState> => updatePrefs({ email: fd.get("email") ?? undefined, sms: fd.get("sms") ?? undefined }),
    null,
  );
  return (
    <form action={run} className="mt-2">
      <FormError message={state?.error} state={state} />
      <div className="divide-y divide-line">
        <Switch id="pref-email" name="email" label="Email reminders" hint="Sent to the email address we have for you." checked={email} onChange={setEmail} />
        <Switch id="pref-sms" name="sms" label="SMS reminders" hint={smsHint} checked={sms} onChange={setSms} />
      </div>
      <div className="pt-4"><SubmitButton pendingLabel="Saving…">Save my choices</SubmitButton></div>
    </form>
  );
}
