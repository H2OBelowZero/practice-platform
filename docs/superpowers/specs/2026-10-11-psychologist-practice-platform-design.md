# Private Psychologist Practice Management Platform: Phase 1 Design

Date: 2026-10-11 · Status: awaiting review · Source: Product Blueprint v1.0 (South Africa)

## 1. Purpose and success criteria

A connected practice-management web app for a solo private psychologist in South Africa, able to grow to a multi-user practice. One workflow runs end to end: enquiry, booking, consent and intake, session, clinical note, invoice, payment, report.

Success means:
- The app is live at a public Vercel URL, backed by a Supabase project the practice owns.
- Workflow A (new patient to paid invoice) works on phone and desktop browsers.
- The security tests in section 9 pass.
- Real patient data is stored only after the go-live checklist (section 11) is complete.

This build is **not** legal or security certification. The blueprint's compliance checklist (POPIA, PAIA, HPCSA) must still be verified by the practice before live use.

## 2. Scope

### In Phase 1
1. Auth: email and password sign-in, TOTP MFA required for all staff roles, session expiry, password recovery.
2. Roles: psychologist, practice administrator (receptionist), bookkeeper, patient, guardian. Associate psychologist is modelled in the schema (assigned-patient scoping) but not exposed in the UI.
3. Practice settings: practice details, HPCSA/practice number, session types (duration, fee, format, buffer), weekly working hours, blocked time, cancellation policy and late-cancellation fee, approval mode (auto-confirm or request).
4. Patients: profile, administrative details, emergency contact, referral source, responsible payer, communication preferences.
5. Booking and calendar: psychologist day, week and agenda views. Patient booking journey (type, slot, register, accept terms, confirm or request). Reschedule and cancel under the cancellation policy. Full change history.
6. Intake and consent: reusable form templates (registration, history, informed consent, privacy acknowledgement, telehealth consent, financial terms, minor/guardian). Save-and-resume, validation, timestamps, versioning. Consent recorded per purpose.
7. Clinical notes: templates (SOAP, DAP, free-form), risk fields, states draft, signed, amended. Signed notes are immutable; corrections are addenda. Incomplete-note reminders.
8. Billing: invoice generated from a completed appointment, numbering, due dates, discounts, deposits, cancellation charges, credit notes, partial payments, receipts. Each invoice has a **payer type** (self-pay, medical aid, or split) and supports these payment methods:
   - Online card/EFT through PayFast, with server-to-server ITN verification.
   - Manually recorded payments: bank transfer (EFT), cash, and card machine at the practice. Each needs a reference, date and the recording user, and is audited.
   - Medical aid (main payment route, see item 8a).
8a. Medical-aid billing: scheme and member records per patient (scheme, plan, member number, dependant code, main member), ICD-10 diagnosis codes and tariff/practice codes per invoice line, pre-authorisation reference, claim records (reference, submitted date, status `draft|submitted|accepted|part_paid|rejected|paid`), rejection reason and resubmission history, remittance/payment allocation from the scheme, and patient-liability tracking (co-payment or shortfall stays visible and payable by the patient). Claim state is kept separate from payment state: submitted does not mean paid. **Submission is tracked manually in Phase 1** (staff mark a claim submitted via the scheme's channel or a clearing house and record outcomes). Automated electronic submission waits for a verified integration (Phase 3).
9. Reminders: scheduled email reminders through a provider interface; SMS and push are logged stubs until a provider is chosen. No clinical content in any reminder.
10. Dashboard, tasks and follow-ups (due date, priority, link to patient or appointment).
11. Reports: income vs invoiced, debtors ageing, appointments (utilisation, cancellations, no-shows), new patients, CSV export. Clinical analytics are separate and psychologist-only.
12. Audit log: logins, record views, note signing and amendment, exports, permission changes, payment events. Append-only.
13. Patient portal: Home, Appointments, Documents (forms and consents), Payments, privacy settings. Emergency disclaimer always visible.

### Deferred (Phases 2 and 3)
Telehealth, secure messaging, treatment plans, document management beyond intake attachments, refunds, automated electronic medical-aid claim submission (manual claim tracking and ICD-10 coding are in Phase 1), accounting/ledger/balance sheet, calendar and accounting integrations, native apps, offline use, AI documentation, group/family sessions, multi-practitioner UI.

## 3. Architecture

- **Next.js 15 (App Router, TypeScript)** deployed on **Vercel**. One codebase serves the staff workspace (`/app`), patient portal (`/portal`) and public booking (`/book`).
- **Supabase**: Postgres (data), Auth (identity, MFA), Storage (private buckets), `pg_cron` (reminder and overdue jobs), RLS (authorisation).
- **Authorisation is enforced twice:** Postgres row-level security on every table, and server-side checks in route handlers and server actions. The UI hides controls but is never the control.
- **Server-only code** (service-role key, PayFast secret, passphrase) lives in route handlers and server actions. The service role is used only for webhooks, scheduled jobs and audit writes, never for user-initiated reads.
- **UI:** Tailwind CSS, accessible primitives (Radix), responsive layouts (bottom nav on mobile, sidebar on desktop). Visual direction per blueprint section 11: soft sage, muted blue, warm white and neutral grey; readable type; status shown by icon and text as well as colour; visible focus.
- **Environments:** local (Supabase CLI), staging (Supabase project plus Vercel preview), production. Migrations are SQL files in `supabase/migrations`.
- **Region:** the Supabase project should use the closest available region to South Africa; the practice must confirm cross-border transfer obligations (POPIA s72) before live use.

## 4. Roles and access matrix

| Data | Psychologist | Admin | Bookkeeper | Patient | Guardian |
|---|---|---|---|---|---|
| Practice settings | write | read, limited write | none | none | none |
| Patient profile and contact | write | write | none | own | linked patient, per permission |
| Appointments | write | write | read (no names, amounts only) | own | linked patient |
| Forms and consents | read, request | read status, request | none | own | linked patient |
| Clinical notes | write | **none** | **none** | none | none |
| Invoices and payments | write | write | read | own | linked patient (if payer) |
| Medical-aid membership and claims | write | write | amounts and status only | own membership | linked patient |
| ICD-10 codes on claims | write | read | **none** | none | none |
| Reports (business) | read | read | read | none | none |
| Reports (clinical) | read | none | none | none | none |
| Audit log | read | none | none | none | none |

Rules:
- The psychologist is the only role that can read `clinical_notes`. Granting anyone else access requires an explicit record-level grant, which is audited.
- Patients and guardians are resolved by `auth.uid()` through `patients.user_id` and `guardianships`, never by an id supplied by the client.

## 5. Data model

All tables have `id uuid pk`, `created_at`, and RLS enabled. Monetary values are integer cents (ZAR). Times are `timestamptz`; the practice timezone is `Africa/Johannesburg`.

- `practices` (single row in Phase 1): name, registration numbers, timezone, approval_mode, cancellation_window_hours, late_cancel_fee_cents, vat_registered, vat_rate.
- `profiles`: `user_id` (auth.users), role (`psychologist|admin|bookkeeper|patient|guardian|associate`), display_name, mfa_required.
- `patients`: user_id (nullable until registered), patient_number, names, date_of_birth, contact fields, language, comms preferences, emergency contact, referral source, payer, status (`prospect|active|archived`), is_minor.
- `guardianships`: guardian_user_id, patient_id, permissions (jsonb), authority_note, valid_from, valid_to.
- `session_types`: name, duration_min, fee_cents, format (`in_person|video`), buffer_min, deposit_cents, active.
- `availability_rules`: weekday, start_time, end_time. `blocked_times`: starts_at, ends_at, reason.
- `appointments`: patient_id, session_type_id, starts_at, ends_at, status (`requested|tentative|confirmed|attended|no_show|cancelled`), cancelled_by, cancel_reason. Exclusion constraint: no two appointments with `status in (tentative, confirmed)` may overlap in time (`EXCLUDE USING gist` on `tstzrange`).
- `appointment_events`: appointment_id, event, actor, detail, at. Written by trigger on every change.
- `form_templates` (versioned: key, version, schema jsonb, active) and `form_submissions` (patient_id, template_id, template_version, answers jsonb, status `draft|submitted|returned`, submitted_at).
- `consents`: patient_id, purpose (`treatment|privacy_notice|telehealth|financial_terms|share_referrer|share_insurer`), granted, granted_at, withdrawn_at, form_submission_id, template_version.
- `note_templates`; `clinical_notes`: patient_id, appointment_id, template_id, state (`draft|signed|amended`), content jsonb, risk jsonb, author_id, signed_at.
- `note_versions`: note_id, version_no, content, saved_by, saved_at (append-only). `note_addenda`: note_id, content, author_id, created_at. A trigger rejects UPDATE and DELETE of the content of a signed note.
- `invoices`: number (sequential per practice), patient_id, appointment_id, issue_date, due_date, status (`draft|issued|part_paid|paid|void`), subtotal, discount, vat, total, deposit_applied.
- `invoice_lines`, `credit_notes`.
- `payments`: invoice_id, method (`payfast|eft|cash|card_machine|medical_aid`), gateway_ref (**unique when present**), amount_cents, status (`pending|succeeded|failed`), raw_payload, verified_at, recorded_by (for manual methods).
- `medical_aid_members`: patient_id, scheme, plan, member_number, dependant_code, main_member_name, main_member_id_ref, valid_from, valid_to.
- `icd10_codes` (seeded reference list of common psychology codes, editable), `invoice_lines` gain `icd10_code`, `tariff_code`.
- `claims`: invoice_id, member_id, preauth_ref, claim_ref, status, submitted_at, claimed_cents, approved_cents, rejection_reason, reconciled_at. `claim_events` (append-only history of status changes and resubmissions). `claim_payments` (scheme remittances allocated to claims, which also create `payments` rows with method `medical_aid`).
- Invoice balance splits into `scheme_portion_cents` and `patient_portion_cents`; reports show both.
- `tasks`: title, due_at, priority, status, assignee, patient_id, appointment_id, source.
- `notifications_outbox`: channel, template, recipient, payload (no clinical content), status, attempts, send_after. Processed by a scheduled job.
- `audit_log`: actor_id, role, action, entity, entity_id, ip, at, detail. INSERT only; no UPDATE or DELETE policy for any role.
- `retention_policies`: record_type, retain_years, legal_hold. Informational only. No automatic deletion in Phase 1.

## 6. Key flows and rules

**Booking (workflow A, B).** The slot list is computed on the server from availability rules, blocked time, existing appointments, buffers and the practice timezone. Creating an appointment inserts inside one transaction; the exclusion constraint is the final authority, so two concurrent requests for one slot yield one success and one clean "slot taken" error. Public slot responses contain times only, never other patients' details. `approval_mode=request` creates `requested`; the psychologist confirms to `confirmed`. Cancel or reschedule checks ownership, the cancellation window and the policy, writes `appointment_events`, releases the slot, queues notifications, and creates a cancellation-fee invoice line when the policy applies.

**Consent.** Registering an account records no consents. Each consent purpose is granted through its own form and stored with the template version. Withdrawal sets `withdrawn_at` and raises a task for the psychologist.

**Notes.** Draft notes autosave to `note_versions`. Signing sets `state=signed`, `signed_at`, and writes an audit entry. After signing, changes are allowed only as `note_addenda`, and the state becomes `amended`. A high-risk flag creates a task prompting professional assessment and produces no automated diagnosis.

**Billing and payment (workflow C).**
1. Marking an appointment `attended` offers invoice generation from the session type fee and the billing rules.
2. The patient pays through a PayFast checkout built server-side with a signed payload.
3. `POST /api/payfast/itn` verifies the signature, the source IP range, that the amount matches the invoice, and (via PayFast's validate endpoint) that the notification is genuine. Only then does it insert a `payments` row, upserting on `gateway_ref` so duplicates are no-ops.
4. A trigger recomputes the invoice balance and status (`part_paid`, `paid`) and queues a receipt.
5. Returning to the success page changes nothing; it only displays the stored status.

**Medical-aid flow.** Staff create the invoice with payer type medical aid or split, attach ICD-10 and tariff codes and any pre-authorisation reference, and open a claim. The claim moves draft, submitted, then accepted, part_paid, rejected or paid, with every change in `claim_events`. A rejection raises a task; resubmission creates a new event, not a new claim. Recording a scheme remittance allocates it to claims and creates a `medical_aid` payment, which updates `scheme_portion` and the invoice balance. Any remaining `patient_portion` (shortfall or co-payment) stays on the invoice and is payable by PayFast or a manual method. The bookkeeper sees claim amounts and statuses without patient names or ICD-10 codes (diagnosis codes are clinical data: psychologist and admin only).

**Manual payments.** Admin or psychologist records EFT, cash or card-machine payments against an invoice with date and reference. The same balance trigger applies. Over-payment is rejected.

**Reminders.** `pg_cron` enqueues reminders at the configured offsets. A worker route sends from `notifications_outbox` with retries. Messages carry date, time and a portal link only.

## 7. Security and privacy controls

- TLS everywhere (Vercel and Supabase). Encryption at rest provided by Supabase; secrets only in Vercel environment variables. Never committed.
- MFA (TOTP) enforced for staff before any staff route renders. Session expiry and re-authentication for sensitive actions (export, permission change).
- Private storage buckets; signed URLs with short expiry; object paths are scoped by patient id and covered by storage policies.
- Audit log covers the actions in section 2 item 12. Read access is limited to the psychologist.
- Input validation with Zod at every trust boundary. Rate limiting on auth, booking and public endpoints.
- Security headers (CSP, HSTS, frame-ancestors none, referrer policy) set in `next.config`.
- Backups: Supabase automated backups plus a documented restore drill (section 11). Point-in-time recovery requires the paid plan, noted in the checklist.
- Data-subject requests: an admin-visible queue creates a task and an audit entry; fulfilment is manual in Phase 1.
- Emergency disclaimer and the practice's crisis procedure text are shown in the portal and on booking confirmation. The text is configured by the psychologist.

## 8. Accessibility and cross-platform

Keyboard navigable, visible focus, labelled controls, sufficient contrast, status by text and icon, text resizing to 200%, screen-reader landmarks. Mobile-first portal; psychologist workspace has bottom navigation (Dashboard, Calendar, Patients, Tasks, More) on phones. Dates, currency (R, ZAR) and phone numbers follow South African formats. Unsaved-form recovery via autosave; clear save indicators and recoverable errors.

## 9. Testing

- **Database/RLS tests** (pgTAP or Vitest against a local Supabase): patient A cannot select patient B's rows in any table; admin and bookkeeper get zero rows from `clinical_notes`; patients cannot write `audit_log`; no role can UPDATE a signed note's content; overlapping confirmed appointments are rejected.
- **Unit tests:** slot generation (timezone, buffers, blocked time), cancellation-fee rules, invoice totals and VAT, PayFast signature building and ITN verification.
- **Medical-aid tests:** claim state never changes invoice paid status by itself; a scheme remittance allocates correctly and leaves the patient portion; rejection and resubmission keep history; over-payment is rejected; bookkeeper gets no ICD-10 codes.
- **Integration tests:** duplicate ITN is idempotent; amount mismatch is rejected; failed and partial payments set the correct status; concurrent booking of one slot yields exactly one success.
- **End-to-end (Playwright, desktop and mobile viewports):** workflow A, workflow B and workflow C.
- Typecheck, lint and tests run in CI before any deploy.

## 10. Repository and delivery

A single repo at `practice-platform/`, with remote `https://github.com/H2OBelowZero/practice-platform.git` (approved by the owner as the offsite store). Only source, migrations and fictional seed data go in the repo; no secrets or real patient data. It contains `app/`, `lib/`, `supabase/migrations/`, `supabase/seed.sql` (fictional data, local and staging only), `tests/`, and a `README` with setup and deploy steps. Implementation plan follows this spec through the writing-plans skill.

## 11. Deployment and go-live

Actions only the practice owner can perform:
1. Create a Supabase project and a Vercel account; supply project URL and keys through Vercel environment variables.
2. Create a PayFast sandbox account for testing, then a live account for production.
3. Choose an email provider and add its API key. SMS and push stay as logged stubs.

The implementation will provide the migrations, the build, and the `vercel` and `supabase` CLI commands to deploy once the accounts exist.

**Go-live checklist (blueprint section 10), required before real patient data:**
- Patient-isolation and role tests pass against production configuration.
- A backup restore has been performed and documented; the incident escalation procedure is written.
- Consent and privacy-notice templates reviewed by the practice and legal advisor.
- Information Officer named; PAIA manual and POPIA operator agreements in place with Supabase, Vercel, PayFast and the email provider.
- Data region and cross-border transfer position confirmed.
- A staff MFA enrolment verified for every staff account.

## 12. Open items for the practice (not blockers for the build)

- Final wording of consent forms, cancellation terms and crisis procedure.
- Retention periods per record type (HPCSA guidance varies; no automatic deletion until confirmed).
- Email provider selection.
- Whether the associate psychologist role is needed in Phase 2.
