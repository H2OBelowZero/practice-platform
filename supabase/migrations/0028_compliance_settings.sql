-- supabase/migrations/0028_compliance_settings.sql
-- Task 16c. The settings audit trigger (0027) writes TWO rows for one change of the payment instructions: 'settings.change' and 'settings.payment_instructions'. The
-- compliance report's "Settings changes" count must say one change as one, so report_compliance (0025) is redefined here, identical except that the second row is
-- not counted. Everything else (guard, range check, families, columns, grants) is unchanged; create or replace keeps the existing grants.

create or replace function report_compliance(p_from date, p_to date)
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
      from audit_log l where (l.at at time zone 'Africa/Johannesburg')::date between p_from and p_to
         and l.action <> 'settings.payment_instructions'), -- the extra row of a payment-instruction change (0027): it is the same change, counted once under settings.change
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
