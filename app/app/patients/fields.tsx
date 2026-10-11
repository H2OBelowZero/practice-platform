import type { Values } from "@/lib/appointments/types";
import { LANGUAGES, PAYERS } from "@/lib/patients/options";
import type { PatientRecord } from "@/lib/patients/record";
import { Input, Select } from "@/components/ui/field";

type Errors = Record<string, string>;

/** Form defaults (all strings, as a form submits them) for a stored record. */
export const profileValues = (p: PatientRecord): Values => ({
  first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth ?? "", email: p.email ?? "", phone: p.phone ?? "",
  language: p.language ?? "en", comms_email: p.comms_prefs?.email ? "on" : "", comms_sms: p.comms_prefs?.sms ? "on" : "",
});
export const adminValues = (p: PatientRecord): Values => ({
  emergency_name: p.emergency_contact?.name ?? "", emergency_phone: p.emergency_contact?.phone ?? "", emergency_relationship: p.emergency_contact?.relationship ?? "",
  referral_source: p.referral_source ?? "", payer: p.payer ?? "self", status: p.status,
});

function Check({ id, label, hint, checked }: { id: string; label: string; hint?: string; checked: boolean }) {
  return (
    <div className="mb-3 flex items-start gap-3">
      <input id={id} name={id} type="checkbox" defaultChecked={checked} aria-describedby={hint ? `${id}-hint` : undefined} className="mt-1 h-6 w-6 shrink-0 accent-sage-700" />
      <label htmlFor={id} className="font-medium">
        {label}
        {hint && <span id={`${id}-hint`} className="block text-sm font-normal text-ink-muted">{hint}</span>}
      </label>
    </div>
  );
}

/** Name, date of birth, contact details, language and how the practice may get in touch. */
export function ProfileFields({ v, errors = {} }: { v: Values; errors?: Errors }) {
  return (
    <>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="first_name" label="First name" required defaultValue={v.first_name} error={errors.first_name} maxLength={100} autoComplete="off" />
        <Input id="last_name" label="Last name" required defaultValue={v.last_name} error={errors.last_name} maxLength={100} autoComplete="off" />
      </div>
      <Input id="date_of_birth" label="Date of birth" type="date" defaultValue={v.date_of_birth} error={errors.date_of_birth} hint="Optional. Under-18s are marked as minors." />
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Input id="email" label="Email address" type="email" defaultValue={v.email} error={errors.email} maxLength={254} autoComplete="off" />
        <Input id="phone" label="Phone number" type="tel" defaultValue={v.phone} error={errors.phone} maxLength={30} autoComplete="off" hint="Saved in international form, for example +27821234567." />
      </div>
      <Select id="language" label="Home language" defaultValue={v.language || "en"} error={errors.language}>
        {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
      </Select>
      <fieldset className="mb-5">
        <legend className="mb-2 font-medium">How may the practice contact this patient?</legend>
        <Check id="comms_email" label="Email" checked={v.comms_email === "on"} />
        <Check id="comms_sms" label="SMS" checked={v.comms_sms === "on"} />
      </fieldset>
    </>
  );
}

/** Emergency contact, referral source and who pays. `statusEditable` adds the prospect/active choice. */
export function AdminFields({ v, errors = {}, statusEditable = true }: { v: Values; errors?: Errors; statusEditable?: boolean }) {
  return (
    <>
      <fieldset className="mb-5">
        <legend className="mb-2 font-medium">Emergency contact</legend>
        <p className="mb-3 text-sm text-ink-muted">Someone to reach if there is a concern for the patient&apos;s safety. Leave all three blank if there is none yet.</p>
        <div className="grid gap-x-4 sm:grid-cols-3">
          <Input id="emergency_name" label="Name" defaultValue={v.emergency_name} error={errors.emergency_name} maxLength={100} autoComplete="off" />
          <Input id="emergency_phone" label="Phone number" type="tel" defaultValue={v.emergency_phone} error={errors.emergency_phone} maxLength={30} autoComplete="off" />
          <Input id="emergency_relationship" label="Relationship" defaultValue={v.emergency_relationship} error={errors.emergency_relationship} maxLength={60} autoComplete="off" />
        </div>
      </fieldset>
      <Input id="referral_source" label="Referral source" defaultValue={v.referral_source} error={errors.referral_source} maxLength={200} hint="Who referred this patient, or how they found the practice." />
      <Select id="payer" label="Who pays" defaultValue={v.payer || "self"} error={errors.payer}>
        {PAYERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      {statusEditable && (
        <Select id="status" label="Status" defaultValue={v.status || "prospect"} error={errors.status} hint="A prospect has not started yet. Archive a patient from the section below.">
          <option value="prospect">Prospect</option>
          <option value="active">Active</option>
        </Select>
      )}
    </>
  );
}
