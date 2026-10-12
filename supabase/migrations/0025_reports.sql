-- supabase/migrations/0025_reports.sql
-- Task 16b. Practice reports, summed in the database. Phase 1 reports are BASIC: no expenses, no profit and loss, no balance sheet (Phase 3), and no clinical analytics.
--
-- Rules shared by every function here:
--  * SECURITY INVOKER (the caller's RLS applies), search_path public, pg_temp. The one exception is report_income_by_session_type (see its comment).
--  * An explicit role guard FIRST: the roles allowed for that report, else 'forbidden'. A service_role call has no staff role and is refused too (as 0024).
--  * p_from / p_to are SAST calendar dates: from <= to, at most 800 days apart, else 'invalid_range'. Timestamps are turned into SAST dates with
--    (ts at time zone 'Africa/Johannesburg')::date, so a month or day boundary is the South African one whatever the server time zone.
--  * Aggregates only. No patient name or id appears in any result, except patient_id in report_debtors_detail for psychologist and admin.
--  * R4 grants: revoke from public, anon; grant to authenticated, service_role.
-- Money is integer cents. Rates are returned as fractions (0.1234 = 12.3 %) rounded to 4 decimals, NULL when the denominator is zero.

-- ---- 1. income by month ---------------------------------------------------------------------------------------------------------------
-- BOOKED invoices (used by the income, session type, debtors and transactions reports): status issued / part_paid / paid, OR void BECAUSE OF CREDITS: the database
-- voids an unpaid invoice once its credit notes reach its total (invoice_recompute), and such an invoice was still invoiced, so it must stay in the month it was
-- issued (a closed month never changes when a credit note is added later). A void invoice whose credits are less than its total was voided by hand and is not booked.
-- Drafts are never booked. In SQL: status in (...) or (status = 'void' and total > 0 and sum(credit notes) >= total).
--
-- invoiced = total of BOOKED invoices ISSUED in the month (issue_date); vat = their VAT; received = succeeded payments by received_on;
-- credit = credit notes by the SAST date they were created, on every non-draft invoice; vat_credited = the VAT those credit notes carry: each credit note's VAT is
-- the difference of round(running credited total * invoice VAT / invoice total) before and after it (credit notes of an invoice in order of creation), so the VAT of
-- all the credit notes of an invoice adds up to round(credited * VAT / total) and to the invoice VAT exactly once it is credited in full.
-- Every calendar month touched by the range gets a row (zeros included); only dates inside [p_from, p_to] count, so the first and last month can be partial.
create function report_income_by_month(p_from date, p_to date)
returns table (month_start date, invoices_n bigint, invoiced_cents bigint, vat_cents bigint, vat_credited_cents bigint, received_cents bigint, credit_cents bigint)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if coalesce(auth_role()::text, '') not in ('psychologist', 'admin', 'bookkeeper') then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then raise exception 'invalid_range'; end if;
  return query
  with months as (
    select g::date as mo from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') g),
  inv as (
    select date_trunc('month', i.issue_date::timestamp)::date as mo, count(*) as n, sum(i.total_cents) as total, sum(i.vat_cents) as vat
      from invoices i
     where (i.status in ('issued', 'part_paid', 'paid')
            or (i.status = 'void' and i.total_cents > 0 and coalesce((select sum(k.amount_cents) from credit_notes k where k.invoice_id = i.id), 0) >= i.total_cents))
       and i.issue_date between p_from and p_to group by 1),
  pay as (
    select date_trunc('month', p.received_on::timestamp)::date as mo, sum(p.amount_cents) as amount
      from payments p where p.status = 'succeeded' and p.received_on between p_from and p_to group by 1),
  crv as (
    select c.created_at, c.amount_cents,
           case when i.total_cents > 0 then
             round(sum(c.amount_cents) over w * i.vat_cents::numeric / i.total_cents) - round((sum(c.amount_cents) over w - c.amount_cents) * i.vat_cents::numeric / i.total_cents)
           else 0 end as vat
      from credit_notes c join invoices i on i.id = c.invoice_id
     where i.status <> 'draft'
    window w as (partition by c.invoice_id order by c.created_at, c.id rows between unbounded preceding and current row)),
  cr as (
    select date_trunc('month', v.created_at at time zone 'Africa/Johannesburg')::date as mo, sum(v.amount_cents) as amount, sum(v.vat) as vat
      from crv v where (v.created_at at time zone 'Africa/Johannesburg')::date between p_from and p_to group by 1)
  select m.mo, coalesce(inv.n, 0)::bigint, coalesce(inv.total, 0)::bigint, coalesce(inv.vat, 0)::bigint, coalesce(cr.vat, 0)::bigint, coalesce(pay.amount, 0)::bigint, coalesce(cr.amount, 0)::bigint
    from months m left join inv on inv.mo = m.mo left join pay on pay.mo = m.mo left join cr on cr.mo = m.mo
   order by m.mo;
end $$;

-- ---- 2. income by method --------------------------------------------------------------------------------------------------------------
-- succeeded payments by received_on; every method is listed (zeros included) so the table and the CSV have a stable shape.
create function report_income_by_method(p_from date, p_to date)
returns table (method text, payments_n bigint, received_cents bigint)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if coalesce(auth_role()::text, '') not in ('psychologist', 'admin', 'bookkeeper') then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then raise exception 'invalid_range'; end if;
  return query
  select m.method, count(p.id)::bigint, coalesce(sum(p.amount_cents), 0)::bigint
    from (values ('payfast', 1), ('eft', 2), ('cash', 3), ('card_machine', 4), ('medical_aid', 5)) as m(method, ord)
    left join payments p on p.method = m.method and p.status = 'succeeded' and p.received_on between p_from and p_to
   group by m.method, m.ord order by m.ord;
end $$;

-- ---- 3. income by session type --------------------------------------------------------------------------------------------------------
-- invoiced total (invoices issued in the range, issued / part_paid / paid) grouped by the session type of the linked appointment; no linked appointment = 'Other / manual'.
-- SECURITY DEFINER on purpose, and the ONE exception to "invoker": the bookkeeper may read this report but has no RLS access to appointments, so an invoker
-- version would put every invoice under 'Other / manual' for them. The role guard is the same as the other money reports, the output is name + counts + cents only
-- (a session type name is practice data, not patient data), and nothing but the invoice total, issue date and the appointment's session type is read.
create function report_income_by_session_type(p_from date, p_to date)
returns table (session_type text, invoices_n bigint, invoiced_cents bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if coalesce(auth_role()::text, '') not in ('psychologist', 'admin', 'bookkeeper') then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then raise exception 'invalid_range'; end if;
  return query
  select coalesce(st.name, 'Other / manual'), count(*)::bigint, coalesce(sum(i.total_cents), 0)::bigint
    from invoices i
    left join appointments a on a.id = i.appointment_id
    left join session_types st on st.id = a.session_type_id
   where (i.status in ('issued', 'part_paid', 'paid')
            or (i.status = 'void' and i.total_cents > 0 and coalesce((select sum(k.amount_cents) from credit_notes k where k.invoice_id = i.id), 0) >= i.total_cents))
     and i.issue_date between p_from and p_to
   group by coalesce(st.name, 'Other / manual')
   order by (coalesce(st.name, 'Other / manual') = 'Other / manual'), 3 desc, 1;
end $$;

-- ---- 4. debtors ----------------------------------------------------------------------------------------------------------------------
-- What each open invoice owed ON p_as_of (a SAST date from 800 days ago to today): BOOKED invoices (see the top of this file: an invoice voided by credits counts, a
-- manually voided one does not) issued on or before that date (issue_date), minus the succeeded payments received by then and the credit notes created by then. So a
-- debt that was credited off later still shows as owing on a date before the credit, and shows nothing from the credit date on.
-- For today this equals invoice_balances.outstanding_cents. Bucket by whole days past due_date: due today or later = current, 1-30, 31-60, 61-90, 90+ (the same
-- rule as lib/reports/ageing.ts). scheme / patient outstanding follow R40: the scheme owes scheme portion - remittances (medical_aid payments) - scheme credits,
-- the patient owes patient portion - their own payments (every other method) - patient credits, never below zero.
-- patient_id is null for a bookkeeper (invoice number, due date and amounts are enough for them). An invoice voided by hand is never listed, even for an earlier p_as_of.
create function report_debtors_detail(p_as_of date)
returns table (invoice_number text, due_date date, days_overdue int, bucket text, payer_type text, outstanding_cents int, scheme_cents int, patient_cents int, patient_id uuid)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_role text := coalesce(auth_role()::text, '');
begin
  if v_role not in ('psychologist', 'admin', 'bookkeeper') then raise exception 'forbidden'; end if;
  if p_as_of is null or p_as_of > sa_today() or sa_today() - p_as_of > 800 then raise exception 'invalid_range'; end if;
  return query
  with pay as (
    select p.invoice_id, coalesce(sum(p.amount_cents), 0) as paid,
           coalesce(sum(p.amount_cents) filter (where p.method = 'medical_aid'), 0) as scheme_paid,
           coalesce(sum(p.amount_cents) filter (where p.method <> 'medical_aid'), 0) as own_paid
      from payments p where p.status = 'succeeded' and p.received_on <= p_as_of group by p.invoice_id),
  cr as (
    select c.invoice_id, coalesce(sum(c.amount_cents), 0) as credit,
           coalesce(sum(c.amount_cents) filter (where c.portion = 'scheme'), 0) as scheme_credit,
           coalesce(sum(c.amount_cents) filter (where c.portion = 'patient'), 0) as patient_credit
      from credit_notes c where (c.created_at at time zone 'Africa/Johannesburg')::date <= p_as_of group by c.invoice_id),
  x as (
    select i.number, i.due_date, i.payer_type, i.patient_id,
           greatest(0, i.total_cents - coalesce(cr.credit, 0) - coalesce(pay.paid, 0)) as outstanding,
           greatest(0, i.scheme_portion_cents - coalesce(pay.scheme_paid, 0) - coalesce(cr.scheme_credit, 0)) as scheme_out,
           greatest(0, i.patient_portion_cents - coalesce(pay.own_paid, 0) - coalesce(cr.patient_credit, 0)) as patient_out,
           (p_as_of - i.due_date) as late
      from invoices i left join pay on pay.invoice_id = i.id left join cr on cr.invoice_id = i.id
     where (i.status in ('issued', 'part_paid', 'paid')
            or (i.status = 'void' and i.total_cents > 0 and coalesce((select sum(k.amount_cents) from credit_notes k where k.invoice_id = i.id), 0) >= i.total_cents))
       and i.issue_date <= p_as_of)
  select x.number, x.due_date, greatest(x.late, 0),
         case when x.late <= 0 then 'current' when x.late <= 30 then '1-30' when x.late <= 60 then '31-60' when x.late <= 90 then '61-90' else '90+' end,
         x.payer_type, x.outstanding::int, x.scheme_out::int, x.patient_out::int,
         case when v_role = 'bookkeeper' then null else x.patient_id end
    from x where x.outstanding > 0
   order by x.due_date, x.number;
end $$;

-- ---- 4b. debtors summary ---------------------------------------------------------------------------------------------------------------
-- The five buckets (all present, zeros included) summed from the detail above.
create function report_debtors_ageing(p_as_of date)
returns table (bucket text, invoices_n bigint, outstanding_cents bigint, scheme_cents bigint, patient_cents bigint)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if coalesce(auth_role()::text, '') not in ('psychologist', 'admin', 'bookkeeper') then raise exception 'forbidden'; end if;
  if p_as_of is null or p_as_of > sa_today() or sa_today() - p_as_of > 800 then raise exception 'invalid_range'; end if;
  return query
  select b.bucket, count(d.invoice_number)::bigint, coalesce(sum(d.outstanding_cents), 0)::bigint, coalesce(sum(d.scheme_cents), 0)::bigint, coalesce(sum(d.patient_cents), 0)::bigint
    from (values ('current', 1), ('1-30', 2), ('31-60', 3), ('61-90', 4), ('90+', 5)) as b(bucket, ord)
    left join report_debtors_detail(p_as_of) d on d.bucket = b.bucket
   group by b.bucket, b.ord order by b.ord;
end $$;

-- ---- 5. appointments -----------------------------------------------------------------------------------------------------------------
-- Appointments whose start (SAST date) is in the range. One row per session type that has any, then one total row (is_total).
--   booked = confirmed + attended + no_show; attended; no_show; cancelled; late_cancelled = cancelled with a 'status:cancelled' event less than the practice's
--   cancellation window (practices.cancellation_window_hours, the CURRENT setting) before the start, or after it; booked_minutes = booked appointments' length.
--   Tentative and requested appointments are still waiting for a decision and count nowhere.
--   no_show_rate = no_show / (attended + no_show); cancellation_rate = cancelled / (booked + cancelled).
--   available_minutes and utilisation (booked_minutes / available_minutes) are on the total row only (availability is not split by session type), and both are NULL when there is no availability: the availability
--   rules of every calendar day in the range (weekday 0 = Sunday, SAST wall times) minus the time blocked by blocked_times inside those hours (overlapping blocks
--   are counted once). No rules, no rule day in the range, or everything blocked = no availability.
create function report_appointments(p_from date, p_to date)
returns table (session_type text, is_total boolean, booked bigint, attended bigint, no_show bigint, cancelled bigint, late_cancelled bigint, booked_minutes bigint,
               available_minutes bigint, utilisation numeric, no_show_rate numeric, cancellation_rate numeric)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if coalesce(auth_role()::text, '') not in ('psychologist', 'admin') then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then raise exception 'invalid_range'; end if;
  return query
  with win_h as (select coalesce((select cancellation_window_hours from practices limit 1), 24) as h),
  a as (
    select ap.session_type_id, ap.status, ap.starts_at, ap.ends_at,
           (select min(e.at) from appointment_events e where e.appointment_id = ap.id and e.event = 'status:cancelled') as cancel_at
      from appointments ap
     where (ap.starts_at at time zone 'Africa/Johannesburg')::date between p_from and p_to),
  g as (
    select st.name as name, (grouping(st.id) = 1) as is_total,
           count(*) filter (where a.status in ('confirmed', 'attended', 'no_show')) as booked,
           count(*) filter (where a.status = 'attended') as attended,
           count(*) filter (where a.status = 'no_show') as no_show,
           count(*) filter (where a.status = 'cancelled') as cancelled,
           count(*) filter (where a.status = 'cancelled' and a.cancel_at is not null and a.starts_at - a.cancel_at < make_interval(hours => (select h from win_h))) as late_cancelled,
           coalesce(sum(extract(epoch from a.ends_at - a.starts_at) / 60) filter (where a.status in ('confirmed', 'attended', 'no_show')), 0)::bigint as booked_minutes
      from a join session_types st on st.id = a.session_type_id
     group by grouping sets ((st.id, st.name), ())),
  win as (
    select tstzrange((d.d + r.start_time) at time zone 'Africa/Johannesburg', (d.d + r.end_time) at time zone 'Africa/Johannesburg') as w
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as d(d)
      join availability_rules r on r.weekday = extract(dow from d.d)::int),
  avail as (
    select coalesce(sum(extract(epoch from upper(w.w) - lower(w.w)) / 60
             - coalesce((select sum(extract(epoch from upper(x) - lower(x))) / 60
                           from unnest((select range_agg(w.w * tstzrange(b.starts_at, b.ends_at)) from blocked_times b where tstzrange(b.starts_at, b.ends_at) && w.w)) as x), 0)), 0)::bigint as minutes
      from win w)
  select coalesce(g.name, 'All session types'), g.is_total, g.booked, g.attended, g.no_show, g.cancelled, g.late_cancelled, g.booked_minutes,
         case when g.is_total and av.minutes > 0 then av.minutes end,
         case when g.is_total and av.minutes > 0 then round(g.booked_minutes::numeric / av.minutes, 4) end,
         round(g.no_show::numeric / nullif(g.attended + g.no_show, 0), 4),
         round(g.cancelled::numeric / nullif(g.booked + g.cancelled, 0), 4)
    from g cross join avail av
   order by g.is_total, g.name;
end $$;

-- ---- 6. practice activity ------------------------------------------------------------------------------------------------------------
-- One flat table (section, label, detail, n):
--   new_patients   label 'YYYY-MM' (every month of the range, zeros included): patients created in that month inside the range (prospects count)
--   referral       label = referral source as typed (case and blank-insensitive), 'Not recorded' when empty: those same new patients
--   caseload       label 'active': distinct patients with an attended appointment in the 90 days up to and including p_to
--   tasks          label 'created' | 'completed': tasks created in the range, and how many of those are done now (no completion date is stored)
--   claims         label = claim status: claims created in the range
--   payfast_open   label 'open': PayFast payments waiting for staff to match (open payfast_unreconciled tasks, as of now, whatever the range)
-- Clinical risk tasks (risk_flag:*) are left out of every task figure: only the psychologist can see them, and the figures must not depend on who asks.
create function report_practice_activity(p_from date, p_to date)
returns table (section text, label text, detail text, n bigint)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if coalesce(auth_role()::text, '') not in ('psychologist', 'admin') then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then raise exception 'invalid_range'; end if;
  return query
  with np as (select pt.id, pt.referral_source, date_trunc('month', pt.created_at at time zone 'Africa/Johannesburg')::date as mo
                from patients pt where (pt.created_at at time zone 'Africa/Johannesburg')::date between p_from and p_to),
  mths as (select g::date as mo from generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') g),
  tk as (select t.status from tasks t where coalesce(t.source, '') not like 'risk_flag:%' and (t.created_at at time zone 'Africa/Johannesburg')::date between p_from and p_to)
  select 'new_patients'::text, to_char(m.mo, 'YYYY-MM'), null::text, (select count(*) from np where np.mo = m.mo)::bigint from mths m
  union all
  select 'referral', coalesce(min(btrim(np.referral_source) collate "C") filter (where btrim(np.referral_source) <> ''), 'Not recorded'), null, count(*)::bigint
    from np group by lower(btrim(coalesce(np.referral_source, '')))
  union all
  select 'caseload', 'active', null, count(distinct ap.patient_id)::bigint from appointments ap
   where ap.status = 'attended' and (ap.starts_at at time zone 'Africa/Johannesburg')::date between p_to - 89 and p_to
  union all
  select 'tasks', 'created', null, count(*)::bigint from tk
  union all
  select 'tasks', 'completed', null, count(*)::bigint from tk where tk.status = 'done'
  union all
  select 'claims', cl.status, null, count(*)::bigint from claims cl
   where (cl.created_at at time zone 'Africa/Johannesburg')::date between p_from and p_to group by cl.status
  union all
  select 'payfast_open', 'open', null, count(*)::bigint from tasks t where t.status = 'open' and t.source like 'payfast_unreconciled:%';
end $$;

-- ---- 7. compliance (psychologist only) -------------------------------------------------------------------------------------------------
-- System activity, not clinical outcomes. Flat table (section, label, detail, n), counts only, no actor, patient or record is identified:
--   activity            label = logins | patient_views | note_views | claim_views | exports | settings_changes | consent_grants | consent_withdrawals | note_addenda
--                       (audit_log rows by SAST date; settings_changes = actions starting 'settings.' or 'practice.'; exports = 'export.*')
--   consent             label = purpose, detail = granted | withdrawn | none: NOW, for patients who are not archived ('none' = no consent row for that purpose)
--   failed_notifications  label 'failed': staff tasks raised for notifications that could not be sent (outbox_failed:*), created in the range. The outbox itself is
--                       service-role only, so this is the staff-visible count.
--   payfast_rejected    label 'rejected': payfast.itn.rejected audit rows (PayFast calls that passed the signature check and were then refused)
create function report_compliance(p_from date, p_to date)
returns table (section text, label text, detail text, n bigint)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if coalesce(auth_role()::text, '') <> 'psychologist' then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then raise exception 'invalid_range'; end if;
  return query
  with al as (
    select case when l.action = 'auth.login' then 'logins'
                when l.action = 'patient.view' then 'patient_views'
                when l.action = 'note.view' then 'note_views'
                when l.action = 'claim.view' then 'claim_views'
                when l.action like 'export.%' then 'exports'
                when l.action like 'settings.%' or l.action like 'practice.%' then 'settings_changes'
                when l.action = 'consent.grant' then 'consent_grants'
                when l.action = 'consent.withdraw' then 'consent_withdrawals'
                when l.action = 'note.addendum' then 'note_addenda' end as fam
      from audit_log l where (l.at at time zone 'Africa/Johannesburg')::date between p_from and p_to),
  purposes as (select unnest(array['treatment', 'privacy_notice', 'telehealth', 'financial_terms', 'share_referrer', 'share_insurer']) as purpose),
  live as (select count(*) as total from patients where status <> 'archived')
  select 'activity'::text, f.fam, null::text, (select count(*) from al where al.fam = f.fam)::bigint
    from (values ('logins'), ('patient_views'), ('note_views'), ('claim_views'), ('exports'), ('settings_changes'), ('consent_grants'), ('consent_withdrawals'), ('note_addenda')) as f(fam)
  union all
  select 'consent', p.purpose, s.st,
         case s.st when 'granted' then (select count(*) from consents c join patients pt on pt.id = c.patient_id where c.purpose = p.purpose and c.granted and pt.status <> 'archived')
                   when 'withdrawn' then (select count(*) from consents c join patients pt on pt.id = c.patient_id where c.purpose = p.purpose and not c.granted and pt.status <> 'archived')
                   else (select live.total from live) - (select count(*) from consents c join patients pt on pt.id = c.patient_id where c.purpose = p.purpose and pt.status <> 'archived') end::bigint
    from purposes p cross join (values ('granted'), ('withdrawn'), ('none')) as s(st)
  union all
  select 'failed_notifications', 'failed', null, count(*)::bigint from tasks t
   where t.source like 'outbox_failed:%' and (t.created_at at time zone 'Africa/Johannesburg')::date between p_from and p_to
  union all
  select 'payfast_rejected', 'rejected', null, count(*)::bigint from audit_log l
   where l.action = 'payfast.itn.rejected' and (l.at at time zone 'Africa/Johannesburg')::date between p_from and p_to;
end $$;

-- ---- 8. transactions (the accountant export) ------------------------------------------------------------------------------------------
-- One row per succeeded payment (by received_on) and one NEGATIVE row per credit note (by its SAST creation date, on every non-draft invoice, also one that the credit itself voided).
--   reference: medical_aid = the remittance advice number (claim_payments.remittance_ref, never the composite gateway_ref); payfast = the PayFast payment reference;
--              eft / card_machine / cash = the reference staff typed (a bank reference can contain a payer's name, which is why the app warns about it); credit note = null.
--   vat_cents: only when the practice is VAT registered (else null). The VAT of a payment is the difference of round(running total paid on that invoice * invoice VAT /
--              invoice total) before and after it (payments of an invoice in order of date received, then creation), so the VAT of all the payments of an invoice
--              adds up to the invoice VAT to the cent once it is paid in full (the odd cents fall out of the running total, not out of each row). Credit notes are
--              treated the same way among themselves and carry negative VAT. A credit-voided invoice keeps its credit rows (see BOOKED at the top).
--   portion: 'scheme' for a medical_aid payment or a scheme credit, 'patient' otherwise.
-- No patient name or id. At most 20000 rows: more raises 'too_many_rows' (narrow the dates).
create function report_transactions(p_from date, p_to date)
returns table (txn_date date, kind text, invoice_number text, method text, reference text, portion text, amount_cents bigint, vat_cents bigint)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
declare v_vat boolean; v_n bigint;
begin
  if coalesce(auth_role()::text, '') not in ('psychologist', 'admin', 'bookkeeper') then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then raise exception 'invalid_range'; end if;
  select (select count(*) from payments p where p.status = 'succeeded' and p.received_on between p_from and p_to)
       + (select count(*) from credit_notes c join invoices i on i.id = c.invoice_id
           where i.status <> 'draft' and (c.created_at at time zone 'Africa/Johannesburg')::date between p_from and p_to)
    into v_n;
  if v_n > 20000 then raise exception 'too_many_rows'; end if;
  select coalesce((select vat_registered from practices limit 1), false) into v_vat;
  return query
  with pv as (
    select p.id, p.received_on, p.created_at, p.method, p.status, p.gateway_ref, p.reference, p.amount_cents, i.number,
           case when i.total_cents > 0 then
             round(sum(p.amount_cents) over w * i.vat_cents::numeric / i.total_cents) - round((sum(p.amount_cents) over w - p.amount_cents) * i.vat_cents::numeric / i.total_cents)
           else 0 end as vat
      from payments p join invoices i on i.id = p.invoice_id
     where p.status = 'succeeded'
    window w as (partition by p.invoice_id order by p.received_on, p.created_at, p.id rows between unbounded preceding and current row)),
  cv as (
    select c.id, c.created_at, c.amount_cents, c.portion, i.number,
           case when i.total_cents > 0 then
             round(sum(c.amount_cents) over w * i.vat_cents::numeric / i.total_cents) - round((sum(c.amount_cents) over w - c.amount_cents) * i.vat_cents::numeric / i.total_cents)
           else 0 end as vat
      from credit_notes c join invoices i on i.id = c.invoice_id
     where i.status <> 'draft'
    window w as (partition by c.invoice_id order by c.created_at, c.id rows between unbounded preceding and current row))
  select t.txn_date, t.kind, t.invoice_number, t.method, t.reference, t.portion, t.amount_cents, t.vat_cents from (
    select pv.received_on as txn_date, 'payment'::text as kind, pv.number as invoice_number, pv.method as method,
           case pv.method when 'medical_aid' then (select cp.remittance_ref from claim_payments cp where cp.payment_id = pv.id)
                          when 'payfast' then pv.gateway_ref else pv.reference end as reference,
           case when pv.method = 'medical_aid' then 'scheme' else 'patient' end as portion,
           pv.amount_cents::bigint as amount_cents,
           case when v_vat then pv.vat::bigint end as vat_cents,
           pv.created_at as ord_at
      from pv where pv.received_on between p_from and p_to
    union all
    select (cv.created_at at time zone 'Africa/Johannesburg')::date, 'credit_note', cv.number, 'credit_note', null, cv.portion,
           -cv.amount_cents::bigint,
           case when v_vat then -cv.vat::bigint end,
           cv.created_at
      from cv where (cv.created_at at time zone 'Africa/Johannesburg')::date between p_from and p_to
  ) as t
  order by t.txn_date, t.kind, t.invoice_number, t.ord_at, t.method, t.amount_cents;
end $$;

-- ---- grants (R4) -----------------------------------------------------------------------------------------------------------------------
revoke execute on function report_income_by_month(date, date) from public, anon;
grant execute on function report_income_by_month(date, date) to authenticated, service_role;
revoke execute on function report_income_by_method(date, date) from public, anon;
grant execute on function report_income_by_method(date, date) to authenticated, service_role;
revoke execute on function report_income_by_session_type(date, date) from public, anon;
grant execute on function report_income_by_session_type(date, date) to authenticated, service_role;
revoke execute on function report_debtors_detail(date) from public, anon;
grant execute on function report_debtors_detail(date) to authenticated, service_role;
revoke execute on function report_debtors_ageing(date) from public, anon;
grant execute on function report_debtors_ageing(date) to authenticated, service_role;
revoke execute on function report_appointments(date, date) from public, anon;
grant execute on function report_appointments(date, date) to authenticated, service_role;
revoke execute on function report_practice_activity(date, date) from public, anon;
grant execute on function report_practice_activity(date, date) to authenticated, service_role;
revoke execute on function report_compliance(date, date) from public, anon;
grant execute on function report_compliance(date, date) to authenticated, service_role;
revoke execute on function report_transactions(date, date) from public, anon;
grant execute on function report_transactions(date, date) to authenticated, service_role;
