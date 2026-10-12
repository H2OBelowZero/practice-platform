import { requireRole } from "@/lib/auth/session";
import { SMS_ACTIVE } from "@/lib/notify/provider";
import { prefsNotice, readPrefs } from "@/lib/portal/prefs";
import { supabaseServer } from "@/lib/supabase/server";
import { ActionForm } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Switch } from "@/components/ui/switch";
import { updatePrefs } from "./actions";

export const metadata = { title: "Settings" };

/**
 * How the practice may contact you. Reads and writes the signed-in patient's OWN record through their RLS client; contact details are shown but
 * only the practice changes them (it keeps one verified contact per person). A guardian manages nothing here: the child's record is the practice's.
 */
export default async function PortalSettings({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const me = await requireRole(["patient", "guardian"]);
  const sp = await searchParams;
  const sb = await supabaseServer();
  // user_id filter in addition to RLS: a guardian can read the child's row, but this page is about the signed-in person's own record only
  const { data: mine, error } = await sb.from("patients").select("id, email, phone, comms_prefs").eq("user_id", me.userId).order("created_at", { ascending: true }).limit(1).maybeSingle();
  const prefs = readPrefs(mine?.comms_prefs);

  return (
    <>
      <PageHeader title="Settings" description="Choose which reminders you would like to receive." />
      {prefsNotice(sp.notice) && <Notice tone="success">{prefsNotice(sp.notice)}</Notice>}
      {error && <Notice tone="error">We could not load your settings. Please refresh the page.</Notice>}
      {!error && !mine && <Notice tone="info">There are no reminder settings on this account. If you look after someone else, the practice manages their reminders. Please contact the practice to change them.</Notice>}

      {mine && (
        <>
          <Card className="mb-6">
            <h2 className="mb-1">Reminders</h2>
            <p className="text-ink-muted">We send one reminder about a day before each appointment. Reminders only give the date and time and a link; they never include anything private.</p>
            <ActionForm action={updatePrefs} args={[]} submitLabel="Save my choices" pendingLabel="Saving…" className="mt-2">
              <div className="divide-y divide-line">
                <Switch id="pref-email" name="email" label="Email reminders" hint="Sent to the email address we have for you." defaultChecked={prefs.email} />
                <Switch id="pref-sms" name="sms" label="SMS reminders" defaultChecked={prefs.sms}
                        hint={SMS_ACTIVE ? "Sent to the cellphone number we have for you." : "SMS reminders are not active yet. Your choice is saved for when they are."} />
              </div>
              <div className="pt-4" />
            </ActionForm>
          </Card>

          <Card>
            <h2 className="mb-1">Contact details we have for you</h2>
            <dl className="mt-3 grid gap-3 sm:grid-cols-[10rem_1fr]">
              <dt className="font-medium">Email</dt>
              <dd data-testid="contact-email">{mine.email || <span className="text-ink-muted">None on record</span>}</dd>
              <dt className="font-medium">Cellphone</dt>
              <dd data-testid="contact-phone">{mine.phone || <span className="text-ink-muted">None on record</span>}</dd>
            </dl>
            <p className="mt-4 text-ink-muted">To change these, please contact the practice.</p>
          </Card>
        </>
      )}
    </>
  );
}
