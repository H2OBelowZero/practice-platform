# Decisions made while building the Practice Platform

Written for the practice owner, in plain language. It explains what the system does, the choices made along the way, why, and what each choice costs or limits. The technical runbook is the README; the design brief is `docs/superpowers/specs/`.

## 1. The product in ten lines

1. A website for one private psychology practice in South Africa, usable on a phone or a computer.
2. Patients book online, sign in to a private portal, fill in forms, give or withdraw consent, see appointments and invoices, and pay by card.
3. The psychologist, a receptionist (admin) and a bookkeeper each get a staff area; what each can see is limited by role.
4. Clinical notes are visible to the psychologist only. Once signed they cannot be changed, only added to.
5. Invoices follow the session. Payment is by card (PayFast), bank transfer, cash or card machine, or through a medical aid.
6. Medical-aid claims are tracked by hand (submitted, paid, rejected). The system does not send claims to schemes.
7. Reminders and confirmations go out by email, containing only a date, a time and a link.
8. Staff sign-in needs a code from an authenticator app. Every important action is written to a log that cannot be edited.
9. Reports show income, outstanding money, appointments and activity, with downloads for your accountant.
10. Nothing has been run on a real server yet. Before real patient information goes in, the checklists in the README must be completed.

## 2. Key decisions and why

Each item: **Decision**, why, and what it costs or limits.

### Security and privacy

- **Two locks on every door.** Access is controlled by the database itself and again by the website code on every page and action. *Why:* a mistake in one layer must not expose patient data. *Cost:* more code and tests; a new page that forgets its check fails a test.
- **Staff accounts are created by you, never by sign-up.** The first staff account is made in the Supabase dashboard and promoted with one line of SQL; anyone who registers on the site is only ever a patient. *Why:* nobody can make themselves staff. *Cost:* a manual step per new staff member.
- **Staff must use an authenticator app code.** *Why:* a stolen password alone is not enough. *Cost:* the person creating an account should be present for the first sign-in, because until the app is linked anyone with the password could link their own.
- **"Confirm email" must be switched on.** A staff-created patient record is linked to a self-registered account only if the email is confirmed, the practice invited the person and exactly one record matches. *Why:* otherwise someone could register another person's address and read their file. *Cost:* if the setting is off, the safeguard fails; it is on the go-live checklist. Look-alike records raise a "possible duplicate" task instead of linking.
- **Nobody can write to the audit log except the server.** Not staff, not patients. Logins, record views, note signing, exports, payments and settings changes are recorded; only the psychologist can read them. *Cost:* if the server cannot write an audit entry at sign-in, the sign-in is refused (fails safe).
- **Records of care and money are never deleted.** Appointments, notes, forms, consents, invoices, payments and audit entries cannot be deleted by anyone, including the owner through the app; the database refuses. Patients are archived instead. *Why:* professional and tax record keeping, and tamper-resistance. *Cost:* a legal erasure request needs a careful one-off procedure agreed with your adviser (README section 9).
- **Pages stay private to the browser.** Signed-in pages carry "do not store" headers, a strict content policy and clean error pages that never show technical detail. *Cost:* every page is built fresh on each visit (slightly slower, no page caching).
- **Dangerous database powers are switched off for the website's keys** (for example wiping a whole table). *Cost:* a check must be re-run after anything is created in the Supabase dashboard by hand (README, step 6.3).
- **Passwords of at least 12 characters; password reset needs a fresh email link, and staff also need their code.** *Cost:* slightly longer sign-up.
- **Known software warnings are reviewed, not ignored.** Some development tools carry advisories that can only be fixed by upgrading Next.js to the next major version. The safety check in the build fails only on new serious ones. *Cost:* a planned upgrade is still due.

### Bookings and the calendar

- **Free times are computed on the server** from your working hours, blocked time and existing bookings, including a ten-minute buffer. Two people cannot take the same slot: the database allows only one. *Cost:* a patient sometimes sees "just taken" and must pick again.
- **You choose whether bookings are automatic or need your approval** (the demo uses approval). New bookings follow that setting; the patient cannot choose. *Cost:* in approval mode the patient waits for your confirmation.
- **A patient can hold at most five future bookings they made themselves, and book up to 60 days ahead.** Bookings made by staff do not count. *Why:* stops abuse. *Cost:* a very regular client may need staff to book further ahead.
- **Late cancellation: the patient is warned first, and the system makes a task, not an invoice.** Cancelling inside the window (24 hours by default) with a fee set creates one "review fee" task for staff, who turn it into an invoice with one click. Patients cannot move an appointment that is already inside the window (otherwise they could move it far away and cancel for free). *Why:* you stay in control of whether to charge. *Cost:* the fee is never automatic.
- **Moving a booking keeps its current status** (a confirmed one stays confirmed even in approval mode). Revisit if you want moves re-approved.
- **Staff can book outside normal hours** (an override); patients cannot.
- **Not built:** month view and drag-and-drop in the calendar (day, week and agenda views only); a waiting list.

### Clinical notes

- **Only the psychologist sees notes.** The admin and bookkeeper get a "not found" page. Granting anyone else access would be a deliberate, recorded step (not built). *Cost:* the receptionist cannot see even whether a note exists.
- **Drafts autosave; signing locks the note; corrections are dated addenda** and the note becomes "amended". Earlier draft versions are kept. *Cost:* a signed typo can only be corrected by an addendum.
- **Risk flags prompt the clinician; they never diagnose.** A moderate or high flag creates a follow-up task visible only to the psychologist (the admin cannot see or silence it).
- **A note links to one appointment of the same patient**, and one appointment has at most one note.

### Forms and consent

- **Consent is recorded per purpose** (treatment, privacy, telehealth, financial terms, sharing with a referrer, sharing with a medical aid) with the date and the exact form version agreed to. Withdrawing keeps the evidence and creates a task for staff. A patient cannot grant consent without submitting the matching form.
- **A submitted form cannot be edited.** Staff can return it with a note; the patient corrects and resubmits, and every submission is kept. *Cost:* extra steps for a small fix, in exchange for evidence.
- **The health-history form is psychologist-only**; the admin cannot read it.
- **Booking terms** are accepted with one tick during booking, recorded as financial-terms consent with the cancellation terms in force at the time.
- **The wording of every form is a DRAFT** and must be reviewed by you and a legal adviser. Changing a form means publishing a new version; used versions are frozen. *Cost:* wording changes need a developer.
- **Minors and guardians:** a guardian acts for a child only with the permissions they were given (book, forms, pay), and a guardian without "pay" sees no invoices.

### Billing and payments

- **Invoices are created from attended appointments** and move draft, issued, part paid, paid or void. Once issued, the amounts are frozen. One live invoice per appointment. Zero-value invoices cannot be issued. Invoice numbers are sequential and never reused.
- **Corrections are credit notes, not edits.** Only the psychologist adds them, with a reason and a clear choice: "Discount for the patient" or "Write off scheme shortfall". An invoice with payments cannot be voided; credit the rest instead.
- **Manual payments need a reference (EFT, card machine) and cannot be future-dated.** Entering the same payment twice asks for confirmation. Over-payment is refused.
- **Bank details are edited in Settings** and changes are audited; patients see them next to the online option. *Why:* changing them is the classic fraud move.
- **PayFast money is recorded only when PayFast's own server confirms it**, never because the patient came back to a "thank you" page. Each notification must have the right signature, come from PayFast's addresses, carry your merchant id, match the invoice amount to the cent and be confirmed by PayFast again. A repeated notification is ignored. *Cost:* a payment can show as "confirming" for a minute.
- **Card payment always pays the whole outstanding balance.** *Why:* simple, and avoids mismatch. *Cost:* no part payments online (part payments are possible by EFT or cash).
- **Payments that no longer fit** (paid twice, or the invoice changed meanwhile) are accepted by PayFast, so the system records no money and creates one high-priority "needs reconciliation" task. You refund in the PayFast dashboard or adjust the books. *Cost:* refunds are manual; the system never calls PayFast to refund.
- **Online payment needs a PayFast passphrase** outside the sandbox. Without it payment is switched off with an explanation.
- **Medical aid:** invoices can be medical aid, self-pay or split, with a scheme portion and a patient portion. A claim is a separate record (draft, submitted, accepted, part paid, rejected, paid); submitting a claim does not pay the invoice. A claim needs at least one ICD-10 code and an amount. A scheme payment (remittance) is entered against the claim; one remittance number can cover several claims. Only the psychologist enters diagnosis codes; the admin manages the claim without them; the bookkeeper sees only amounts and status. *Cost:* you submit to the scheme or clearing house yourself and record the outcome.
- **The patient can pay their own part online only when it is clearly theirs:** on a split or medical-aid invoice, "Pay now" appears only after the scheme side is settled (paid or written off). *Why:* so a patient is never asked to pay what the scheme owes.
- **Invoices that were cancelled by credit notes still count** in the month they were booked; manually voided ones do not. *Why:* closed months must not change.
- **Overdue invoices create one task each**, so follow-up is not forgotten, never a reminder email to the patient.

### Reports

- **Four reports, each defined in plain words beneath the figures:** financial (income by month, by method and session type, ageing, debtors), appointments (utilisation, cancellations, no-shows), practice activity, and compliance (system activity, never clinical outcomes). Each downloads as CSV; formula-looking text in a CSV is neutralised.
- **Role limits:** the psychologist sees all; the admin sees all but compliance; the bookkeeper sees financial only, without patient names.
- **The accountant export is a transactions list, not a ledger.** No expenses or profit-and-loss. *Cost:* your accountant works from the export.
- **VAT is a setting** (default not registered). Small rounding differences of one cent are possible on invoices that mix payments and credits.

### Notifications

- **Emails contain only a date, a time and a link.** No names, amounts, form names or health words, and the footer carries only the general emergency line. The crisis helpline details appear only inside the signed-in portal. *Why:* an email in the wrong hands must not hint at mental-health care.
- **Nothing is sent in production until an email provider is configured.** Messages wait, and ones that go stale (an old reminder) expire rather than send late. The provider in the code (Resend) is a placeholder: you must choose and sign a data agreement with whichever you use.
- **Email addresses and phone numbers can only be changed by staff**, so a patient (or someone with their password) cannot redirect reminders.
- **Reminders go 24 hours before**, for confirmed bookings, if the patient has not switched them off. SMS is off until a provider exists.
- **A message that fails three times creates a staff task** instead of retrying forever.

### Operations

- **The scheduled job runs every 15 minutes** on Vercel. Vercel's free (Hobby) plan allows scheduled jobs to run only once a day, so 15-minute reminders need Vercel Pro, or the job can be run daily, or an outside scheduler can call the same address every 15 minutes (README 6.9). Check Vercel's current plan limits before you rely on this.
- **Staging first, and the demo data is kept away from the live project.** The demo data (`supabase/seed-demo.sql`) is fictional but creates accounts, including a psychologist, with a password printed in the README. It is not loaded by any automatic command; you must run it by hand, on a throwaway staging project only, after switching on an explicit opt-in setting. It also refuses to run unless the database is empty and unnamed. That last check is **not** enough on its own: a brand-new live project is empty and unnamed too, which is why the opt-in exists and why the rule is: never run it on the live project, and prove before go-live that no demo user exists (README section 8). *Cost:* a real clinic enters its own settings by hand.
- **Automatic deletion is not built.** Retention periods are recorded for information; nothing is deleted until you confirm the periods.
- **Backups and incident handling are procedures, not features:** README section 9.
- **A weekly check** of tasks, audit log and system status is the main monitoring.

## 3. Where the build differs from the original design

| Original design | What was built | Why |
| --- | --- | --- |
| Reminders from a database scheduler (pg_cron) | A scheduled web call (Vercel cron) | Simpler hosting; a database scheduler was not needed. Hobby plan limit applies. |
| Automatic cancellation-fee line on an invoice | A staff task, then one-click invoice | You decide each time. |
| Electronic medical-aid submission | Manual claim tracking, as the spec says for Phase 1 | Needs a verified integration (Phase 3). |
| Refunds | Not offered; PayFast refunds are done in its dashboard | Phase 2. |
| Online part payments | Whole balance only | Avoids mismatch; part payments by EFT/cash. |
| SMS and push stubs | SMS reminders are off; email only | No provider chosen. |
| Email provider "to be chosen" | Resend adapter as a placeholder | Needed something to build against; you confirm the provider. |
| Re-authentication before sensitive actions (bank details) | The staff session already passed the authenticator code, plus a confirmation tick, a review step and audit entries | A separate re-sign-in was not built. Set a short session limit in Supabase to compensate. |
| Data-subject request queue | Manual process: a task plus the README procedure | Fulfilment is manual in Phase 1 anyway. |
| Document storage buckets | No file uploads in Phase 1 | Forms are typed answers. |
| Report on income "vs invoiced" and clinical analytics | Financial, appointments, activity, compliance reports; no clinical analytics | Kept to non-clinical figures. |
| Calendar views day, week, agenda | Same, with no month view or drag-and-drop | Deferred. |
| Associate psychologist in the UI | Modelled in the database only | As the spec states. |

## 4. Things you need to decide or confirm

1. **Region and cross-border transfer:** which Supabase and Vercel regions you use, and your legal position for storing data outside South Africa (POPIA section 72).
2. **Information Officer and PAIA manual:** who it is, and registration with the Information Regulator.
3. **Operator agreements** with Supabase, Vercel, PayFast and your email provider.
4. **Email provider:** confirm or replace the placeholder; verify your sending domain.
5. **Wording** of every consent form, the privacy notice, cancellation and financial terms, with a legal adviser. Also your **crisis procedure text**.
6. **Booking mode:** automatic or approval; cancellation window (default 24 hours) and late fee; whether moves should be re-approved.
7. **Session types and fees,** working hours, buffer length, and VAT registration.
8. **Retention periods** per record type and any legal hold (nothing is deleted automatically).
9. **Medical-aid routine:** which clearing house or channel you use, and who records outcomes; whether ICD-10 coding stays with the psychologist only.
10. **Bank details text** shown to patients, and who may change it.
11. **Plans:** check your Supabase plan for the things you need before real data goes in: daily backups and point-in-time recovery, and the session time-box and inactivity timeout (these depend on the plan; the free tier is for testing only). Sending your own sign-up and password-reset email through your email provider (custom SMTP) is available in Supabase's settings and is not what the plan decision hinges on; the built-in sender is rate-limited, so use your own provider. For Vercel, decide between Pro (15-minute reminders) and an outside scheduler. Set the session time limits you choose.
12. **PayFast:** live account, passphrase, and the decision to go live after a clean sandbox test.
13. **Backup and incident plan:** who runs the restore drill, how often, and the call list for an incident.
14. **Whether the receptionist should see anything more or less** (for example the health-history form is hidden from them today).
15. **Email reminders are ON by default for every patient record** (a patient can switch them off in the portal). Reminders hold only a date, a time and a link, but they are still personal information sent by email to an address you hold: confirm that this default, and the wording of the consent and privacy notice, is acceptable under POPIA for your practice, or ask for it to default to off.
16. **Archived patients keep their portal login.** Archiving a patient hides them from your lists but does not lock their account, so they can still see their own appointments, invoices and forms. Decide whether an archived patient should lose access (not built).
17. **Portal invitations are throttled:** the same patient cannot be invited again within ten minutes, to stop accidental repeated emails. Confirm that is the right limit, and that you are happy for an existing record to be linked to a self-registered account only after you have invited that person (the link needs a confirmed email address).
18. **A planned upgrade** to the next major version of the web framework, to clear the remaining known warnings; and PNG app icons if you want the site installable on phones.
19. **Phase 2 priorities:** electronic claims, telehealth, messaging, refunds, SMS, multiple practitioners.
