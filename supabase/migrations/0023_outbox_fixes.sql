-- supabase/migrations/0023_outbox_fixes.sql
-- Task 15 fix round 1 (nothing from 0022 was deployed, but it stays as written and this migration changes it).
--  1. patients.email and patients.phone become staff-only columns (a patient could redirect reminders to any address through the API).
--  2. A row that ends up 'failed' raises ONE staff task (outbox_failed:<id>); the template and channel go in tasks.meta, never a recipient.
--  3. claim_outbox expires stale rows instead of sending them late (reminders for appointments that are no longer confirmed or already started,
--     reminders more than 2 hours past their send time, booking/cancel/reschedule emails older than 48 hours) and only claims the channels asked for.
--  4. enqueue_reminders(p_sms) queues SMS rows only while SMS is switched on, and never for archived patients.
--  5. release_outbox hands a claimed row back without using up an attempt (the run ran out of time before it was sent).

-- ---- 1. contact details are staff-only ----------------------------------------------------------------------------------------------
-- Same as 0008 plus email and phone. Staff and the service role (auth.uid() is null) are unaffected; ensure_patient_record only sets user_id.
create or replace function patients_guard() returns trigger language plpgsql as
$$ begin
  if auth.uid() is not null and coalesce(auth_role()::text, '') not in ('psychologist','admin') and (
       new.id is distinct from old.id
    or (new.user_id is distinct from old.user_id and not (old.user_id is null and _trusted_writer(tg_relid)))
    or new.patient_number is distinct from old.patient_number or new.status is distinct from old.status
    or new.payer is distinct from old.payer or new.is_minor is distinct from old.is_minor
    or new.created_at is distinct from old.created_at
    or new.portal_invited_at is distinct from old.portal_invited_at
    or new.email is distinct from old.email or new.phone is distinct from old.phone) then
    raise exception 'protected patient columns can only be changed by staff';
  end if;
  return new;
end $$;

-- ---- 2. one staff task per failed notification ---------------------------------------------------------------------------------------
create unique index tasks_outbox_failed_once on tasks (source) where source like 'outbox_failed:%';

-- finish_outbox as in 0022, plus the task when the row becomes 'failed' (the 3rd failed attempt). Fixed title, no patient, no recipient:
-- meta holds the template name and channel only. Visible to psychologist and admin like any ordinary task.
create or replace function finish_outbox(p_id bigint, p_ok boolean, p_error text) returns void
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
    insert into tasks(title, priority, source, meta)
    values ('Notification could not be sent', 'normal', 'outbox_failed:' || p_id, jsonb_build_object('template', o.template, 'channel', o.channel))
    on conflict (source) where source like 'outbox_failed:%' do nothing;
  else
    update notifications_outbox set status = 'pending', last_error = v_err, claimed_at = null,
      send_after = now() + o.attempts * interval '10 minutes' where id = p_id;
  end if;
end $$;
revoke execute on function finish_outbox(bigint, boolean, text) from public, anon, authenticated;
grant execute on function finish_outbox(bigint, boolean, text) to service_role;

-- ---- 5. hand a claimed row back unsent, attempt not used ------------------------------------------------------------------------------
create function release_outbox(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update notifications_outbox set status = 'pending', attempts = greatest(attempts - 1, 0), claimed_at = null, send_after = now()
   where id = p_id and status = 'sending';
end $$;
revoke execute on function release_outbox(bigint) from public, anon, authenticated;
grant execute on function release_outbox(bigint) to service_role;

-- ---- 3. claim: expire the stale, claim only the asked-for channels --------------------------------------------------------------------
-- Expired rows become 'failed' with last_error 'expired' and NO staff task (it is not a delivery fault: the message simply no longer applies).
--  * reminder_24h / reminder_24h_sms: the appointment (id taken from dedupe_key 'reminder_24h[_sms]:<uuid>') is no longer confirmed or has started, or the
--    row is more than 2 hours past send_after (for example the email provider was only configured days later);
--  * booking_confirmed / booking_requested / appointment_cancelled / appointment_rescheduled older than 48 hours.
-- Then, as before: pending rows due now with fewer than 3 attempts, and rows stuck in 'sending' for over 10 minutes. A stuck row that already used its
-- attempts is failed ('stuck') and raises the same staff task as any other failed row.
drop function claim_outbox(int);
create function claim_outbox(p_limit int default 25, p_channels text[] default array['email']) returns setof notifications_outbox
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update notifications_outbox o set status = 'failed', last_error = 'expired', claimed_at = null
   where (o.status = 'pending' or (o.status = 'sending' and o.claimed_at < now() - interval '10 minutes'))
     and ((o.template in ('reminder_24h', 'reminder_24h_sms')
           and (o.send_after < now() - interval '2 hours'
                or not exists (select 1 from appointments a
                                where a.status = 'confirmed' and a.starts_at > now()
                                  and a.id = case when o.dedupe_key ~ '^reminder_24h(_sms)?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                                  then substring(o.dedupe_key from ':(.*)$')::uuid end)))
          or (o.template in ('booking_confirmed', 'booking_requested', 'appointment_cancelled', 'appointment_rescheduled')
              and o.send_after < now() - interval '48 hours'));

  with stuck as (
    update notifications_outbox set status = 'failed', last_error = 'stuck', claimed_at = null
     where status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts >= 3
     returning id, template, channel)
  insert into tasks(title, priority, source, meta)
  select 'Notification could not be sent', 'normal', 'outbox_failed:' || id, jsonb_build_object('template', template, 'channel', channel) from stuck
  on conflict (source) where source like 'outbox_failed:%' do nothing;

  return query
  with due as (
    select id from notifications_outbox
     where channel = any (coalesce(p_channels, array['email']))
       and ((status = 'pending' and send_after <= now() and attempts < 3)
         or (status = 'sending' and claimed_at < now() - interval '10 minutes' and attempts < 3))
     order by send_after, id
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked),
  claimed as (
    update notifications_outbox o set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
      from due where o.id = due.id returning o.*)
  select * from claimed order by id;
end $$;
revoke execute on function claim_outbox(int, text[]) from public, anon, authenticated;
grant execute on function claim_outbox(int, text[]) to service_role;

-- ---- 4. reminders: SMS only while switched on, never for archived patients ------------------------------------------------------------
drop function enqueue_reminders();
create function enqueue_reminders(p_sms boolean default false) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n_email int; n_sms int := 0;
begin
  with ins as (
    insert into notifications_outbox(channel, template, recipient, payload, dedupe_key)
    select 'email', 'reminder_24h', btrim(p.email),
           jsonb_build_object('date', sast_short_date(a.starts_at),
                              'time', to_char(a.starts_at at time zone 'Africa/Johannesburg', 'HH24:MI'),
                              'link', '/portal/appointments'),
           'reminder_24h:' || a.id
      from appointments a join patients p on p.id = a.patient_id
     where a.status = 'confirmed' and p.status <> 'archived'
       and a.starts_at >= now() + interval '23 hours' and a.starts_at <= now() + interval '25 hours'
       and p.comms_prefs ->> 'email' = 'true' and nullif(btrim(p.email), '') is not null
    on conflict (dedupe_key) where dedupe_key is not null do nothing
    returning 1)
  select count(*) into n_email from ins;

  if coalesce(p_sms, false) then
    with ins as (
      insert into notifications_outbox(channel, template, recipient, payload, dedupe_key)
      select 'sms', 'reminder_24h_sms', btrim(p.phone),
             jsonb_build_object('date', sast_short_date(a.starts_at),
                                'time', to_char(a.starts_at at time zone 'Africa/Johannesburg', 'HH24:MI'),
                                'link', '/portal/appointments'),
             'reminder_24h_sms:' || a.id
        from appointments a join patients p on p.id = a.patient_id
       where a.status = 'confirmed' and p.status <> 'archived'
         and a.starts_at >= now() + interval '23 hours' and a.starts_at <= now() + interval '25 hours'
         and p.comms_prefs ->> 'sms' = 'true' and nullif(btrim(p.phone), '') is not null
      on conflict (dedupe_key) where dedupe_key is not null do nothing
      returning 1)
    select count(*) into n_sms from ins;
  end if;
  return n_email + n_sms;
end $$;
revoke execute on function enqueue_reminders(boolean) from public, anon, authenticated;
grant execute on function enqueue_reminders(boolean) to service_role;
