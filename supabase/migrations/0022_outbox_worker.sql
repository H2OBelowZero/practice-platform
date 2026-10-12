-- supabase/migrations/0022_outbox_worker.sql
-- Task 15. The notification outbox worker, the 24 hour reminder queue and the overdue-invoice follow-up.
--  * notifications_outbox gains dedupe_key (one reminder per appointment), last_error (a short CODE, never a provider response),
--    sent_at, claimed_at, and a 'sending' status (a row a worker holds).
--  * claim_outbox / finish_outbox: the worker's two doors. Claiming is atomic (FOR UPDATE SKIP LOCKED), so two overlapping cron runs
--    never send the same row; a row left in 'sending' for 10 minutes (a crashed run) is claimed again.
--  * enqueue_reminders(): confirmed appointments starting 23 to 25 hours from now, for patients who allow that channel.
--  * enqueue_overdue_tasks(): one staff task per overdue invoice.
-- Every function here is security definer and executable by the service role ONLY (the cron route calls them with the service client).
-- The table itself stays service-role only (RLS enabled, no policies, privileges revoked from anon and authenticated).

alter table notifications_outbox add column dedupe_key text;
alter table notifications_outbox add column last_error text;
alter table notifications_outbox add column sent_at timestamptz;
alter table notifications_outbox add column claimed_at timestamptz;
alter table notifications_outbox drop constraint notifications_outbox_status_check;
alter table notifications_outbox add constraint notifications_outbox_status_check check (status in ('pending', 'sending', 'sent', 'failed'));
alter table notifications_outbox add constraint notifications_outbox_last_error_code check (last_error is null or last_error ~ '^[A-Za-z0-9_]{1,40}$');

create unique index notifications_outbox_dedupe on notifications_outbox (dedupe_key) where dedupe_key is not null;
create index notifications_outbox_due on notifications_outbox (send_after, id) where status in ('pending', 'sending');

-- re-assert: nothing but the service role touches the outbox
alter table notifications_outbox enable row level security;
revoke all on notifications_outbox from anon, authenticated;
revoke all on sequence notifications_outbox_id_seq from anon, authenticated;

-- ---- claim / finish ------------------------------------------------------------------------------------------------------------------
-- Claims up to p_limit (1..100) due rows: pending with send_after <= now() and attempts < 3, or 'sending' for more than 10 minutes.
-- Each claimed row has attempts + 1 and claimed_at = now(). A row stuck in 'sending' that already used its 3 attempts is failed instead
-- ('stuck'), so a crash loop cannot send forever.
create function claim_outbox(p_limit int default 25) returns setof notifications_outbox
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update notifications_outbox set status = 'failed', last_error = 'stuck', claimed_at = null
   where status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts >= 3;
  return query
  with due as (
    select id from notifications_outbox
     where (status = 'pending' and send_after <= now() and attempts < 3)
        or (status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts < 3)
     order by send_after, id
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked),
  claimed as (
    update notifications_outbox o set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
      from due where o.id = due.id returning o.*)
  select * from claimed order by id;
end $$;
revoke execute on function claim_outbox(int) from public, anon, authenticated;
grant execute on function claim_outbox(int) to service_role;

-- Records the outcome for a claimed row. Success: 'sent' with sent_at. Failure: back to 'pending' with send_after = now() + attempts * 10 minutes,
-- or 'failed' once the 3 attempts are used. Only a short code is kept (letters, digits and underscore, at most 40); anything else is stripped.
-- A row that is not currently claimed ('sending') is left alone (a late finish after a re-claim must not overwrite the newer attempt).
create function finish_outbox(p_id bigint, p_ok boolean, p_error text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o notifications_outbox; v_err text;
begin
  select * into o from notifications_outbox where id = p_id for update;
  if not found then raise exception 'unknown_outbox'; end if;
  if o.status <> 'sending' then return; end if;
  if coalesce(p_ok, false) then
    update notifications_outbox set status = 'sent', sent_at = now(), last_error = null, claimed_at = null where id = p_id;
    return;
  end if;
  v_err := left(regexp_replace(coalesce(p_error, ''), '[^A-Za-z0-9_]', '', 'g'), 40);
  if v_err = '' then v_err := 'error'; end if;
  if o.attempts >= 3 then
    update notifications_outbox set status = 'failed', last_error = v_err, claimed_at = null where id = p_id;
  else
    update notifications_outbox set status = 'pending', last_error = v_err, claimed_at = null,
      send_after = now() + o.attempts * interval '10 minutes' where id = p_id;
  end if;
end $$;
revoke execute on function finish_outbox(bigint, boolean, text) from public, anon, authenticated;
grant execute on function finish_outbox(bigint, boolean, text) to service_role;

-- ---- reminders -----------------------------------------------------------------------------------------------------------------------
-- "Mon 7 Jan 2030" for an instant, read in South African time (no locale dependence).
create function sast_short_date(p_ts timestamptz) returns text language sql immutable set search_path = public, pg_temp as
$$ select (array['Sun','Mon','Tue','Wed','Thu','Fri','Sat'])[extract(dow from p_ts at time zone 'Africa/Johannesburg')::int + 1]
       || ' ' || extract(day from p_ts at time zone 'Africa/Johannesburg')::int
       || ' ' || (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[extract(month from p_ts at time zone 'Africa/Johannesburg')::int]
       || ' ' || extract(year from p_ts at time zone 'Africa/Johannesburg')::int $$;
revoke execute on function sast_short_date(timestamptz) from public, anon, authenticated;
grant execute on function sast_short_date(timestamptz) to service_role;

-- One reminder per confirmed appointment that starts between 23 and 25 hours from now (both ends inclusive), per channel the patient
-- allows (comms_prefs.email / comms_prefs.sms = true) and has a contact for. dedupe_key makes a repeat run (cron every 15 minutes
-- sees the same appointment for 8 runs) insert nothing. The payload is the date, the time and a PATH only: the worker prepends APP_URL.
-- SMS rows are queued too; the Phase 1 SMS provider only logs (see lib/notify/provider.ts). Returns the number of rows inserted.
create function enqueue_reminders() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n_email int; n_sms int;
begin
  with ins as (
    insert into notifications_outbox(channel, template, recipient, payload, dedupe_key)
    select 'email', 'reminder_24h', btrim(p.email),
           jsonb_build_object('date', sast_short_date(a.starts_at),
                              'time', to_char(a.starts_at at time zone 'Africa/Johannesburg', 'HH24:MI'),
                              'link', '/portal/appointments'),
           'reminder_24h:' || a.id
      from appointments a join patients p on p.id = a.patient_id
     where a.status = 'confirmed'
       and a.starts_at >= now() + interval '23 hours' and a.starts_at <= now() + interval '25 hours'
       and p.comms_prefs ->> 'email' = 'true' and nullif(btrim(p.email), '') is not null
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning 1)
  select count(*) into n_email from ins;

  with ins as (
    insert into notifications_outbox(channel, template, recipient, payload, dedupe_key)
    select 'sms', 'reminder_24h_sms', btrim(p.phone),
           jsonb_build_object('date', sast_short_date(a.starts_at),
                              'time', to_char(a.starts_at at time zone 'Africa/Johannesburg', 'HH24:MI'),
                              'link', '/portal/appointments'),
           'reminder_24h_sms:' || a.id
      from appointments a join patients p on p.id = a.patient_id
     where a.status = 'confirmed'
       and a.starts_at >= now() + interval '23 hours' and a.starts_at <= now() + interval '25 hours'
       and p.comms_prefs ->> 'sms' = 'true' and nullif(btrim(p.phone), '') is not null
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning 1)
  select count(*) into n_sms from ins;
  return n_email + n_sms;
end $$;
revoke execute on function enqueue_reminders() from public, anon, authenticated;
grant execute on function enqueue_reminders() to service_role;

-- ---- overdue invoices ----------------------------------------------------------------------------------------------------------------
-- ONE staff task per overdue invoice (issued or part paid, due date before today in South Africa, something still owed), ever: the partial
-- unique index makes a repeat run a no-op, including after staff mark the task done. No names in the title; meta.invoice_id leads the tasks page
-- to the invoice. Visible to psychologist and admin like any ordinary task (not a risk_flag task). Returns the number of tasks created.
create unique index tasks_overdue_invoice_once on tasks (source) where source like 'overdue_invoice:%';

create function enqueue_overdue_tasks() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  with ins as (
    insert into tasks(title, priority, patient_id, source, meta)
    select 'Overdue invoice: follow up', 'normal', b.patient_id, 'overdue_invoice:' || b.id, jsonb_build_object('invoice_id', b.id)
      from invoice_balances b
     where b.status in ('issued', 'part_paid') and b.outstanding_cents > 0
       and b.due_date is not null and b.due_date < (now() at time zone 'Africa/Johannesburg')::date
    on conflict (source) where source like 'overdue_invoice:%' do nothing
    returning 1)
  select count(*) into n from ins;
  return n;
end $$;
revoke execute on function enqueue_overdue_tasks() from public, anon, authenticated;
grant execute on function enqueue_overdue_tasks() to service_role;
