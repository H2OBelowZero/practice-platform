import Link from "next/link";
import { ActionButton } from "@/components/ui/action-form";
import { Card } from "@/components/ui/card";
import { EmergencyNotice } from "@/components/ui/emergency-notice";
import { Icon } from "@/components/ui/icon";
import { Notice } from "@/components/ui/notice";
import { StatusChip } from "@/components/ui/status-chip";
import { PURPOSE_INFO } from "@/lib/forms/consent";
import type { ConsentPurpose } from "@/lib/forms/validate";
import { formatZar, formatZarInput } from "@/lib/money";
import { clashText } from "@/lib/settings/blocks";
import { PAYFAST_NOTIFY_PATH, type CronRun, type IntegrationStatus } from "@/lib/settings/env-status";
import { describeDay, WEEK, windowsKey, type Win } from "@/lib/settings/hours";
import { formKey } from "@/lib/settings/keys";
import type { BlockRow, PracticeRow, RetentionRow, SessionTypeRow, StaffRow, TemplateRow } from "@/lib/settings/load";
import { READ_ONLY_TEXT, retentionLabel, retentionSummary, ROLE_LABEL, sortRetention } from "@/lib/settings/sections";
import { sastDate, sastDateLabel, sastTime } from "@/lib/time";
import { KeepForm } from "@/app/app/billing/keep-form";
import { copyMondayToWeekdays, removeBlock } from "@/app/app/settings/actions";
import { BlockForm, DayEditor, PaymentForm, PracticeForm, RetentionForm, SessionTypeForm } from "./forms";

// The settings sections, as plain (synchronous) components over data the page has already read. `canEdit` only decides whether a form or the plain values are
// drawn; every action checks the role again on the server.
export const ReadOnlyNotice = ({ extra }: { extra?: string }) => (
  <Notice tone="info" title="Read only">
    <p>{READ_ONLY_TEXT}.{extra ? ` ${extra}` : ""}</p>
  </Notice>
);

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid gap-1 border-b border-line py-3 last:border-b-0 sm:grid-cols-[14rem_1fr]"><dt className="font-medium">{label}</dt><dd>{children}</dd></div>
);
const Flag = ({ on, yes = "Yes", no = "No" }: { on: boolean; yes?: string; no?: string }) => (
  <span className="inline-flex items-center gap-1.5"><Icon name={on ? "check" : "minus"} /><span>{on ? yes : no}</span></span>
);

// ---- practice -------------------------------------------------------------------------------------------------------------------------------------------
export function PracticeSection({ practice, canEdit }: { practice: PracticeRow; canEdit: boolean }) {
  if (canEdit) {
    return (
      <Card>
        <h2 className="mb-4">Practice details</h2>
        <PracticeForm key={formKey(practice.name, practice.registration_no, practice.hpcsa_no, practice.approval_mode, practice.cancellation_window_hours, practice.late_cancel_fee_cents, practice.vat_registered, practice.vat_rate, practice.crisis_text)} initial={{
          name: practice.name, registrationNo: practice.registration_no ?? "", hpcsaNo: practice.hpcsa_no ?? "", approvalMode: practice.approval_mode,
          cancellationWindowHours: String(practice.cancellation_window_hours), lateCancelFee: formatZarInput(practice.late_cancel_fee_cents),
          vatRegistered: practice.vat_registered, vatRate: String(practice.vat_rate).replace(".", ","), crisisText: practice.crisis_text,
        }} />
      </Card>
    );
  }
  return (
    <Card>
      <h2 className="mb-2">Practice details</h2>
      <dl>
        <Row label="Practice name">{practice.name}</Row>
        <Row label="Registration number">{practice.registration_no || "Not set"}</Row>
        <Row label="HPCSA number">{practice.hpcsa_no || "Not set"}</Row>
        <Row label="New bookings">{practice.approval_mode === "auto" ? "Confirmed automatically" : "The practitioner confirms each booking first"}</Row>
        <Row label="Cancellation window">{practice.cancellation_window_hours} hours</Row>
        <Row label="Late-cancellation fee">{formatZar(practice.late_cancel_fee_cents)}</Row>
        <Row label="VAT">{practice.vat_registered ? `Registered, ${String(practice.vat_rate).replace(".", ",")}%` : "Not registered"}</Row>
        <Row label="Time zone">Africa/Johannesburg</Row>
      </dl>
      <h3 className="mb-2 mt-5">Crisis and escalation text</h3>
      <p className="mb-2 text-sm text-ink-muted">Patients see this on their booking confirmation, in the footer of every portal page and on telehealth pages.</p>
      <EmergencyNotice text={practice.crisis_text} />
    </Card>
  );
}

// ---- payment instructions ------------------------------------------------------------------------------------------------------------------------
export function PaymentSection({ text, canEdit }: { text: string; canEdit: boolean }) {
  return (
    <Card>
      <h2 className="mb-2">Payment instructions</h2>
      <Notice tone="warning" title="Check this carefully">
        <p>Patients see this text. Criminals change bank details to redirect payments. Check it carefully, and only ever change it yourself.</p>
        <p>Every change is recorded in the audit log (who and when, never the text itself).</p>
      </Notice>
      {canEdit
        ? <PaymentForm key={formKey(text)} initial={text} />
        : <><p className="mb-2 text-sm text-ink-muted">What patients are shown next to the online payment option:</p><pre className="whitespace-pre-wrap break-words rounded-xl border border-line bg-sunk p-4 font-sans">{text}</pre></>}
    </Card>
  );
}

// ---- session types -------------------------------------------------------------------------------------------------------------------------------------
const FORMAT_LABEL: Record<string, string> = { in_person: "In person", video: "Video" };
const typeInitial = (t: SessionTypeRow) => ({ name: t.name, durationMin: String(t.duration_min), fee: formatZarInput(t.fee_cents), format: t.format, bufferMin: String(t.buffer_min), active: t.active });

export function SessionTypesSection({ types, canEdit }: { types: SessionTypeRow[]; canEdit: boolean }) {
  return (
    <Card>
      <h2 className="mb-2">Session types</h2>
      <p className="mb-4 text-ink-muted">These are the sessions patients can book. A session type is never deleted, because appointments and invoices refer to it: switch it off instead and it disappears from the booking page.</p>
      {types.length === 0 && <Notice tone="info" title="None yet"><p>There are no session types, so nobody can book online. Add the first one below.</p></Notice>}
      {types.length > 0 && (
        <ul aria-label="Session types" className="m-0 mb-6 grid list-none gap-3 p-0">
          {types.map((t) => (
            <li key={t.id} className="rounded-xl border border-line p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium">{t.name}</p>
                {t.active ? <StatusChip status="active" /> : <StatusChip status="archived" label="Inactive: not bookable" />}
              </div>
              <p className="mt-1 text-sm text-ink-muted">{t.duration_min} minutes · {formatZar(t.fee_cents)} · {FORMAT_LABEL[t.format] ?? t.format} · buffer {t.buffer_min} minutes</p>
              {canEdit && (
                <details className="mt-3">
                  <summary className="inline-flex min-h-11 cursor-pointer items-center text-blue-700 underline underline-offset-4">Edit<span className="sr-only"> {t.name}</span></summary>
                  <div className="mt-3"><SessionTypeForm key={formKey(t.id, t.name, t.duration_min, t.fee_cents, t.format, t.buffer_min, t.active)} id={t.id} initial={typeInitial(t)} /></div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <details>
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-blue-700 underline underline-offset-4">Add a session type</summary>
          <div className="mt-3"><SessionTypeForm initial={{ name: "", durationMin: "50", fee: "", format: "in_person", bufferMin: "10", active: true }} /></div>
        </details>
      )}
    </Card>
  );
}

// ---- working hours -------------------------------------------------------------------------------------------------------------------------------------
export function HoursSection({ days, canEdit }: { days: Record<number, Win[]>; canEdit: boolean }) {
  return (
    <Card>
      <h2 className="mb-2">Working hours</h2>
      <Notice tone="info" title="What a change affects">
        <p>Changes apply to future bookings only. Appointments that are already booked are not moved or cancelled, even if they now fall outside your hours.</p>
        <p>Times are South African time. A day can have several windows, for example a morning and an afternoon. A day with no windows is closed. Appointments cannot run past 23:55.</p>
      </Notice>
      {canEdit && (
        <div className="mb-6">
          <KeepForm action={copyMondayToWeekdays} args={[]} submitLabel="Copy Monday's saved hours to Tuesday to Friday" pendingLabel="Copying…" variant="secondary"
                    confirm={{ title: "Replace Tuesday to Friday?", body: <p>The hours of Tuesday, Wednesday, Thursday and Friday are replaced with Monday&apos;s saved hours. Appointments already booked are not changed.</p>, yes: "Yes, copy" }} />
          <p className="mt-1 text-sm text-ink-muted">Replaces the hours of Tuesday to Friday with Monday&apos;s saved hours. Save Monday first if you changed it.</p>
        </div>
      )}
      <ul aria-label="Working hours by day" className="m-0 grid list-none gap-4 p-0">
        {WEEK.map((d) => (
          <li key={d.weekday} className="rounded-xl border border-line p-4">
            <h3 className="mb-1">{d.label}</h3>
            {canEdit
              ? <DayEditor key={windowsKey(d.weekday, days[d.weekday] ?? [])} weekday={d.weekday} label={d.label} initial={days[d.weekday] ?? []} />
              : <p>{describeDay(days[d.weekday] ?? [])}</p>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---- blocked time -------------------------------------------------------------------------------------------------------------------------------------
export function BlockedSection({ blocks, canEdit, added }: { blocks: BlockRow[]; canEdit: boolean; added: number }) {
  return (
    <Card>
      <h2 className="mb-2">Blocked time and leave</h2>
      <p className="mb-4 text-ink-muted">Time that cannot be booked: leave, conferences, admin days. Patients simply do not see these times. Existing appointments are never cancelled or moved by a block.</p>
      {added > 0 && <Notice tone="warning" title="Appointments inside this block"><p>{clashText(added)}</p><p><Link href="/app/calendar?view=agenda">Open the calendar</Link> to move or cancel them.</p></Notice>}
      <h3 className="mb-2">Upcoming blocks</h3>
      {blocks.length === 0 && <p className="mb-6 text-ink-muted">Nothing is blocked. Past blocks are not listed.</p>}
      {blocks.length > 0 && (
        <ul aria-label="Upcoming blocked time" className="m-0 mb-6 grid list-none gap-3 p-0">
          {blocks.map((b) => {
            const day = sastDate(b.starts_at), lastDay = sastDate(new Date(Date.parse(b.ends_at) - 1));
            return (
              <li key={b.id} className="rounded-xl border border-line p-4">
                <p className="font-medium">
                  {sastDateLabel(b.starts_at)}, {sastTime(b.starts_at)} to {lastDay === day ? sastTime(b.ends_at) : `${sastDateLabel(b.ends_at)}, ${sastTime(b.ends_at)}`}
                </p>
                {b.reason && <p className="text-ink-muted">{b.reason}</p>}
                {b.clashes > 0 && (
                  <p className="mt-2 flex items-start gap-1.5 text-warn-ink">
                    <Icon name="alert" className="mt-1" />
                    <span>{clashText(b.clashes)} <Link href={`/app/calendar?view=week&date=${day}`}>Open the calendar for that week</Link>.</span>
                  </p>
                )}
                {canEdit && <div className="mt-3"><ActionButton action={removeBlock} args={[b.id]} submitLabel={<>Remove<span className="sr-only"> block on {sastDateLabel(b.starts_at)}</span></>} pendingLabel="Removing…" variant="secondary" /></div>}
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && <><h3 className="mb-2">Block more time</h3><BlockForm /></>}
    </Card>
  );
}

// ---- retention ---------------------------------------------------------------------------------------------------------------------------------------------
export function RetentionSection({ rows, canEdit, visible }: { rows: RetentionRow[]; canEdit: boolean; visible: boolean }) {
  return (
    <Card>
      <h2 className="mb-2">Record retention</h2>
      <Notice tone="warning" title="Nothing is deleted automatically">
        <p className="text-lg font-semibold">In Phase 1 the platform never deletes any record by itself. These settings only record the practice&apos;s decision.</p>
        <p>HPCSA guidance is that health records are ideally kept indefinitely, and at least six years after the patient last used the service; for minors and for people who cannot decide for themselves, the period is longer. The practice must confirm the right period for each type of record, with the HPCSA guidance and a legal advisor, before it relies on any number here.</p>
        <p>A legal hold means the records must not be disposed of, whatever the period says (for example during a complaint or a claim).</p>
      </Notice>
      {!visible ? <p className="text-ink-muted">Retention settings are visible to the practitioner only.</p>
        : rows.length === 0 ? <Notice tone="info" title="None"><p>No retention rows exist yet.</p></Notice>
        : (
          <ul aria-label="Retention by record type" className="m-0 grid list-none gap-3 p-0">
            {sortRetention(rows).map((r) => {
              const l = retentionLabel(r.record_type);
              return (
                <li key={r.record_type} className="rounded-xl border border-line p-4">
                  <p className="font-medium">{l.label}</p>
                  {l.help && <p className="text-sm text-ink-muted">{l.help}</p>}
                  <p className="mt-1">{retentionSummary(r.retain_years, r.legal_hold)}</p>
                  {canEdit && (
                    <details className="mt-3">
                      <summary className="inline-flex min-h-11 cursor-pointer items-center text-blue-700 underline underline-offset-4">Change<span className="sr-only"> {l.label}</span></summary>
                      <div className="mt-3"><RetentionForm key={formKey(r.record_type, r.retain_years, r.legal_hold)} recordType={r.record_type} years={r.retain_years} hold={r.legal_hold} /></div>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </Card>
  );
}

// ---- information -----------------------------------------------------------------------------------------------------------------------------------------
const purposeLabel = (p: string) => PURPOSE_INFO[p as ConsentPurpose]?.label ?? p;

export function InformationSection({ templates, staff, status, cron, cronVisible, failedNotifications }: {
  templates: TemplateRow[]; staff: StaffRow[]; status: IntegrationStatus; cron: CronRun; cronVisible: boolean; failedNotifications: number | null;
}) {
  return (
    <div className="grid gap-6">
      <Card>
        <h2 className="mb-2">Form templates</h2>
        <Notice tone="warning" title="Draft wording"><p>Wording is draft until reviewed by the practice and a legal advisor. Templates cannot be edited here; a new version is added through the database.</p></Notice>
        {templates.length === 0 ? <p className="text-ink-muted">No templates are loaded.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">Form templates</caption>
              <thead><tr className="border-b border-line-strong"><th scope="col" className="py-2 pr-4">Template</th><th scope="col" className="py-2 pr-4">Version</th><th scope="col" className="py-2 pr-4">Status</th><th scope="col" className="py-2 pr-4">Access</th><th scope="col" className="py-2">Consents recorded</th></tr></thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={`${t.key}-${t.version}`} className="border-b border-line align-top">
                    <th scope="row" className="py-2 pr-4 font-medium">{t.key}</th>
                    <td className="py-2 pr-4">{t.version}</td>
                    <td className="py-2 pr-4">{t.active ? <StatusChip status="active" /> : <StatusChip status="archived" label="Inactive" />}</td>
                    <td className="py-2 pr-4">{t.restricted ? "Restricted: psychologist only" : "Staff"}</td>
                    <td className="py-2">{t.purposes.length ? t.purposes.map(purposeLabel).join(", ") : "None"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-2">Staff accounts</h2>
        <p className="mb-3 text-ink-muted">Name and role only. Roles are not changed in the platform in Phase 1: the owner changes them in the Supabase dashboard (Table editor, <code>profiles</code>, the <code>role</code> column), as the README section on staff accounts describes. Every staff role must use two-step sign-in.</p>
        {staff.length === 0 ? <p className="text-ink-muted">No staff accounts could be listed.</p> : (
          <ul aria-label="Staff accounts" className="m-0 list-none p-0">
            {staff.map((s, i) => <li key={i} className="flex justify-between gap-4 border-b border-line py-2 last:border-b-0"><span>{s.display_name}</span><span className="text-ink-muted">{ROLE_LABEL[s.role] ?? s.role}</span></li>)}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-2">Connections</h2>
        <p className="mb-3 text-ink-muted">Yes or no only. Keys and passwords are set in the hosting environment and are never shown here.</p>
        <dl>
          <Row label="Email provider"><Flag on={status.email.configured} yes={`Configured (${status.email.provider})`} no={status.email.provider === "console" ? "Not configured: emails are only logged, nothing is delivered" : "Not configured: no email is sent, messages wait in the queue"} /></Row>
          <Row label="SMS provider"><Flag on={status.sms.active} yes="Switched on" no="Inactive in Phase 1" /></Row>
          <Row label="PayFast"><Flag on={status.payfast.configured} yes={`Configured, ${status.payfast.mode === "sandbox" ? "sandbox (test payments)" : "live"}`} no="Not configured: patients cannot pay online" /></Row>
          <Row label="PayFast passphrase"><Flag on={status.payfast.passphraseSet} /></Row>
          <Row label="PayFast notify path">{PAYFAST_NOTIFY_PATH} <span className="text-sm text-ink-muted">(PayFast needs the app address followed by this path)</span></Row>
          <Row label="Scheduled jobs secret"><Flag on={status.cronSecretSet} yes="Set" no="Not set: reminders cannot run" /></Row>
          <Row label="App address (APP_URL)"><Flag on={status.appUrlSet} yes="Set" no="Not set: links in emails and PayFast return addresses will be wrong" /></Row>
          <Row label="Database host">{status.supabaseHost ?? "Not set"}</Row>
          <Row label="Last scheduled run">
            {!cronVisible ? "Visible to the practitioner only."
              : cron ? <>{sastDateLabel(cron.at)}, {sastTime(cron.at)} {cron.ok === false || cron.errors > 0 ? <strong>(with errors)</strong> : "(no errors)"}</>
              : "No run with activity recorded yet. A quiet run leaves no record."}
          </Row>
          <Row label="Notifications that failed">
            {failedNotifications === null ? "Could not be read." : failedNotifications === 0 ? "None waiting for attention." : <>{failedNotifications} waiting for attention. <Link href="/app/tasks">Open tasks</Link></>}
          </Row>
        </dl>
      </Card>
    </div>
  );
}

