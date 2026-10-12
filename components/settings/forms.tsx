"use client";

import { useContext, useEffect, useState } from "react";
import { FieldErrorContext, KeepForm } from "@/app/app/billing/keep-form";
import { Button } from "@/components/ui/button";
import { EmergencyNotice } from "@/components/ui/emergency-notice";
import { Input, Select, Textarea } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { MAX_WINDOWS, type Win } from "@/lib/settings/hours";
import { LIMITS, paymentPrecheck } from "@/lib/settings/input";
import { addBlock, createSessionType, saveDay, updatePaymentInstructions, updatePractice, updateRetention, updateSessionType } from "@/app/app/settings/actions";

// Settings forms. All use KeepForm, which keeps what was typed when the server answers with a message, and has noValidate: the server checks everything (Zod and the
// database constraints). `useErr` gives the message the server attached to one control.
function useErr() {
  const fe = useContext(FieldErrorContext);
  return (id: string) => (fe.field === id ? fe.error : undefined);
}

// ---- practice ---------------------------------------------------------------------------------------------------------------------------------------
export type PracticeInitial = {
  name: string; registrationNo: string; hpcsaNo: string; approvalMode: string; cancellationWindowHours: string; lateCancelFee: string;
  vatRegistered: boolean; vatRate: string; crisisText: string;
};

function PracticeFields({ initial }: { initial: PracticeInitial }) {
  const err = useErr();
  const [crisis, setCrisis] = useState(initial.crisisText);
  return (
    <>
      <Input id="name" label="Practice name" required maxLength={LIMITS.name} defaultValue={initial.name} error={err("name")} />
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="registrationNo" label="Practice registration number" maxLength={LIMITS.registrationNo} defaultValue={initial.registrationNo} error={err("registrationNo")} />
        <Input id="hpcsaNo" label="HPCSA number" maxLength={LIMITS.hpcsaNo} defaultValue={initial.hpcsaNo} error={err("hpcsaNo")} />
      </div>
      <Select id="approvalMode" label="New bookings" defaultValue={initial.approvalMode} error={err("approvalMode")}
              hint="With &quot;I confirm each booking&quot; a patient's choice is a request until you confirm it. With automatic confirmation the time is booked straight away.">
        <option value="request">I confirm each booking first</option>
        <option value="auto">Confirm bookings automatically</option>
      </Select>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="cancellationWindowHours" label="Cancellation window (hours)" inputMode="numeric" defaultValue={initial.cancellationWindowHours} error={err("cancellationWindowHours")}
               hint="Patients cancel or move an appointment free of charge when it is at least this many hours away. Between 0 and 336." />
        <Input id="lateCancelFee" label="Late-cancellation fee (rand)" inputMode="decimal" defaultValue={initial.lateCancelFee} error={err("lateCancelFee")}
               hint="Enter 0 for no fee. A late cancellation adds a task for you to review the fee; nobody is charged automatically." />
      </div>
      <Switch id="vatRegistered" name="vatRegistered" label="VAT registered" defaultChecked={initial.vatRegistered}
              hint="Switch on only if the practice is registered for VAT. New invoices then include VAT." />
      <Input id="vatRate" label="VAT rate (%)" inputMode="decimal" defaultValue={initial.vatRate} error={err("vatRate")} hint="15 is the standard rate in South Africa." />
      <p className="mb-5"><span className="font-medium">Time zone: </span>Africa/Johannesburg <span className="text-sm text-ink-muted">(fixed; all times in the platform are South African time)</span></p>

      <Textarea id="crisisText" label="Crisis and escalation text" rows={4} required maxLength={LIMITS.crisisText} value={crisis} onChange={(e) => setCrisis(e.target.value)} error={err("crisisText")}
                hint="Patients see this on their booking confirmation, in the footer of every portal page and on telehealth pages. Include who to call and where to go." />
      <div className="mb-5">
        <p className="mb-1.5 font-medium">How patients see it</p>
        <EmergencyNotice text={crisis.trim() || "(Nothing yet. The crisis text is required.)"} />
      </div>
    </>
  );
}

export function PracticeForm({ initial }: { initial: PracticeInitial }) {
  return (
    <KeepForm action={updatePractice} args={[]} submitLabel="Save practice details" pendingLabel="Saving…">
      <PracticeFields initial={initial} />
    </KeepForm>
  );
}

// ---- payment instructions ------------------------------------------------------------------------------------------------------------------------------
function PaymentFields({ text, setText }: { text: string; setText: (s: string) => void }) {
  const err = useErr();
  return (
    <>
      <Textarea id="paymentInstructions" label="Payment instructions (EFT details)" rows={7} required maxLength={LIMITS.paymentInstructions} value={text} onChange={(e) => setText(e.target.value)}
                error={err("paymentInstructions")} hint="Account holder, bank, account number, branch code and the reference patients should use. Plain text, up to 1 500 characters." />
      <div className="mb-5">
        <label className="flex items-start gap-3">
          <input type="checkbox" id="confirmed" name="confirmed" className="mt-1 h-5 w-5 shrink-0" aria-describedby={err("confirmed") ? "confirmed-error" : undefined} aria-invalid={err("confirmed") ? true : undefined} />
          <span>I have checked every character of the bank details against my bank&apos;s records.</span>
        </label>
        {err("confirmed") && <p id="confirmed-error" className="mt-1.5 text-sm font-medium text-danger"><span className="sr-only">Error: </span>{err("confirmed")}</p>}
      </div>
    </>
  );
}

export function PaymentForm({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  return (
    <KeepForm action={updatePaymentInstructions} args={[]} submitLabel="Review and save" pendingLabel="Saving…" precheck={paymentPrecheck}
              confirm={{
                title: "Check the new payment details",
                body: (
                  <>
                    <p className="mb-3">Patients will be told to pay into the account below. Read it once more.</p>
                    <pre className="mb-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-4 font-sans" data-testid="payment-preview">{text.trim() || "(empty)"}</pre>
                    <p className="text-sm text-ink-muted">The change is recorded in the audit log with your name and the time. The text itself is not copied into the log.</p>
                  </>
                ),
                yes: "Yes, these details are correct", variant: "primary",
              }}>
      <PaymentFields text={text} setText={setText} />
    </KeepForm>
  );
}

// ---- session types ---------------------------------------------------------------------------------------------------------------------------------
export type SessionTypeInitial = { name: string; durationMin: string; fee: string; format: string; bufferMin: string; active: boolean };

function SessionTypeFields({ initial, idPrefix }: { initial: SessionTypeInitial; idPrefix: string }) {
  const err = useErr();
  // controls keep the plain names the server expects; the ids are made unique per form because several forms share a page
  const n = (name: string) => ({ name });
  return (
    <>
      <Input id={`${idPrefix}name`} {...n("name")} label="Name" required maxLength={LIMITS.name} defaultValue={initial.name} error={err("name")} />
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id={`${idPrefix}durationMin`} {...n("durationMin")} label="Length (minutes)" inputMode="numeric" defaultValue={initial.durationMin} error={err("durationMin")} hint="Between 5 and 240." />
        <Input id={`${idPrefix}fee`} {...n("fee")} label="Fee (rand)" inputMode="decimal" defaultValue={initial.fee} error={err("fee")} hint="Excluding VAT. For example 950,00." />
        <Select id={`${idPrefix}format`} {...n("format")} label="Format" defaultValue={initial.format} error={err("format")}>
          <option value="in_person">In person</option><option value="video">Video</option>
        </Select>
        <Input id={`${idPrefix}bufferMin`} {...n("bufferMin")} label="Buffer after the session (minutes)" inputMode="numeric" defaultValue={initial.bufferMin} error={err("bufferMin")} hint="Kept free before the next booking. Between 0 and 120." />
      </div>
      <Switch id={`${idPrefix}active`} name="active" label="Active" defaultChecked={initial.active} hint="Switched off, the session type disappears from the booking page. Appointments already booked keep it." />
    </>
  );
}

export function SessionTypeForm({ id, initial }: { id?: string; initial: SessionTypeInitial }) {
  const prefix = id ? `t-${id}-` : "new-type-";
  return id
    ? <KeepForm action={updateSessionType} args={[id]} submitLabel="Save session type" pendingLabel="Saving…"><SessionTypeFields initial={initial} idPrefix={prefix} /></KeepForm>
    : <KeepForm action={createSessionType} args={[]} submitLabel="Add session type" pendingLabel="Saving…"><SessionTypeFields initial={initial} idPrefix={prefix} /></KeepForm>;
}

// ---- working hours -------------------------------------------------------------------------------------------------------------------------------
function DayFields({ weekday, initial }: { weekday: number; initial: Win[] }) {
  const [rows, setRows] = useState(() => initial.map((w, key) => ({ key, ...w })));
  const [nextKey, setNextKey] = useState(initial.length);
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => { if (focusId) { document.getElementById(focusId)?.focus(); setFocusId(null); } }, [focusId]);
  const set = (key: number, field: "start" | "end", v: string) => setRows(rows.map((r) => (r.key === key ? { ...r, [field]: v } : r)));
  return (
    <>
      {rows.length === 0 && <p className="mb-4 text-ink-muted">Closed. No bookings can be made on this day.</p>}
      {rows.map((r, i) => (
        <fieldset key={r.key} className="mb-4 grid grid-cols-[1fr_1fr_auto] items-end gap-x-3 rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-medium">Window {i + 1}</legend>
          <div className="[&>div]:mb-0"><Input id={`d${weekday}-start-${r.key}`} name={`start_${r.key}`} label="From" type="time" step={300} value={r.start} onChange={(e) => set(r.key, "start", e.target.value)} /></div>
          <div className="[&>div]:mb-0"><Input id={`d${weekday}-end-${r.key}`} name={`end_${r.key}`} label="Until" type="time" step={300} value={r.end} onChange={(e) => set(r.key, "end", e.target.value)} /></div>
          <Button variant="quiet" onClick={() => { const keep = rows.filter((x) => x.key !== r.key); setRows(keep); setFocusId(keep.length ? `d${weekday}-start-${(keep[Math.max(0, i - 1)]).key}` : `d${weekday}-add`); }}>
            Remove<span className="sr-only"> window {i + 1}</span>
          </Button>
        </fieldset>
      ))}
      {rows.length < MAX_WINDOWS && (
        <div className="mb-4">
          <Button id={`d${weekday}-add`} variant="secondary" onClick={() => { setRows([...rows, { key: nextKey, start: "08:00", end: "12:00" }]); setFocusId(`d${weekday}-start-${nextKey}`); setNextKey(nextKey + 1); }}>
            Add a window
          </Button>
        </div>
      )}
    </>
  );
}

export function DayEditor({ weekday, label, initial }: { weekday: number; label: string; initial: Win[] }) {
  return (
    <KeepForm action={saveDay} args={[weekday]} submitLabel={`Save ${label}`} pendingLabel="Saving…" variant="secondary">
      <DayFields weekday={weekday} initial={initial} />
    </KeepForm>
  );
}

// ---- blocked time --------------------------------------------------------------------------------------------------------------------------------
function BlockFields() {
  const err = useErr();
  return (
    <>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="starts" label="From" type="datetime-local" step={300} required error={err("starts")} hint="South African time." />
        <Input id="ends" label="Until" type="datetime-local" step={300} required error={err("ends")} hint="South African time." />
      </div>
      <Input id="reason" label="Reason (optional)" maxLength={LIMITS.reason} error={err("reason")} hint="For example Leave or Conference. Visible to the psychologist and the admin only." />
    </>
  );
}
export function BlockForm() {
  return <KeepForm action={addBlock} args={[]} submitLabel="Block this time" pendingLabel="Saving…"><BlockFields /></KeepForm>;
}

// ---- retention -----------------------------------------------------------------------------------------------------------------------------------
function RetentionFields({ recordType, years, hold }: { recordType: string; years: number | null; hold: boolean }) {
  const err = useErr();
  return (
    <>
      <Input id={`ry-${recordType}`} name="retainYears" label="Keep for (years)" inputMode="numeric" defaultValue={years === null ? "" : String(years)} error={err("retainYears")}
             hint="Leave empty to keep these records indefinitely. Between 1 and 100." />
      <Switch id={`lh-${recordType}`} name="legalHold" label="Legal hold" defaultChecked={hold} hint="Switch on when a complaint, claim or investigation means these records must not be disposed of." />
    </>
  );
}
export function RetentionForm({ recordType, years, hold }: { recordType: string; years: number | null; hold: boolean }) {
  return <KeepForm action={updateRetention} args={[recordType]} submitLabel="Save" pendingLabel="Saving…" variant="secondary"><RetentionFields recordType={recordType} years={years} hold={hold} /></KeepForm>;
}

