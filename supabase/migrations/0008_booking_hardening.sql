-- supabase/migrations/0008_booking_hardening.sql
-- Task 10a: buffer sanity, portal invitation marker, patient-record bootstrap for self-registered users,
-- non-staff booking limits (cap, 60-day horizon, buffers).

alter table session_types add constraint session_types_buffer_nonneg check (buffer_min >= 0);

-- Staff-controlled: set when staff invite this person to the portal (Task 11 adds the "Invite to portal" action).
-- Only a row with this set can ever be linked to a self-registered account by ensure_patient_record().
alter table patients add column portal_invited_at timestamptz;

-- Patients may edit their own contact details, never protected columns (staff and service role may). Same as 0001 plus:
--  * portal_invited_at is protected (a patient must never mark themself invited);
--  * user_id may go from NULL to a value only for the function owner (inside ensure_patient_record), never by a direct API update.
create or replace function patients_guard() returns trigger language plpgsql as
$$ begin
  if auth.uid() is not null and coalesce(auth_role()::text, '') not in ('psychologist','admin') and (
       new.id is distinct from old.id
    or (new.user_id is distinct from old.user_id and not (old.user_id is null and _trusted_writer(tg_relid)))
    or new.patient_number is distinct from old.patient_number or new.status is distinct from old.status
    or new.payer is distinct from old.payer or new.is_minor is distinct from old.is_minor
    or new.created_at is distinct from old.created_at
    or new.portal_invited_at is distinct from old.portal_invited_at) then
    raise exception 'protected patient columns can only be changed by staff';
  end if;
  return new;
end $$;

-- A self-registered patient has a profile (signup trigger) but no `patients` row. This returns the caller's row id,
-- creating it on first use. Only role 'patient' (guardians act through guardianships; staff have no patient row).
--
-- Linking an existing staff-created row is an account-takeover risk (anyone can register someone else's address), so it
-- happens only when ALL of these hold: the auth email is CONFIRMED; exactly ONE unlinked row has that email
-- (compared lower(btrim()) on both sides); that row was invited to the portal by staff (portal_invited_at), is not a minor and
-- is not archived. In every other case a new prospect row is created, and when email-matching rows existed (but could not be
-- linked, or several matched) one high-priority task asks staff to review and merge.
create function ensure_patient_record() returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); v_role role_t; v_name text; v_email text; v_confirmed timestamptz;
        v_id uuid; v_first text; v_last text; v_matches int := 0; m patients;
begin
  if me is null then raise exception 'forbidden'; end if;
  select role, display_name into v_role, v_name from profiles where user_id = me;
  if v_role is distinct from 'patient' then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ensure_patient_record:' || me::text, 0)); -- idempotent under concurrency
  select id into v_id from patients where user_id = me order by created_at, id limit 1;
  if v_id is not null then return v_id; end if;

  select nullif(btrim(email), ''), email_confirmed_at into v_email, v_confirmed from auth.users where id = me;
  if v_email is not null then
    select count(*) into v_matches from patients where user_id is null and lower(btrim(email)) = lower(v_email);
    if v_matches = 1 and v_confirmed is not null then
      select * into m from patients where user_id is null and lower(btrim(email)) = lower(v_email) for update;
      if m.portal_invited_at is not null and not m.is_minor and m.status <> 'archived' then
        update patients set user_id = me where id = m.id;
        perform audit_write('patient.link_account', 'patients', m.id);
        return m.id;
      end if;
    end if;
  end if;

  v_name := btrim(coalesce(v_name, ''), E' \t\r\n');
  v_first := coalesce(nullif(split_part(v_name, ' ', 1), ''), 'Patient');
  v_last := coalesce(nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1), E' \t\r\n'), ''), '-');
  insert into patients(user_id, first_name, last_name, email, status)
  values (me, v_first, v_last, v_email, 'prospect') returning id into v_id;
  perform audit_write('patient.self_create', 'patients', v_id);
  if v_matches > 0 then -- a new row is created only once per user (the early return above), so this task is too
    insert into tasks(title, priority, patient_id, source)
    values ('Possible duplicate patient: review and merge', 'high', v_id, 'duplicate_patient');
  end if;
  return v_id;
end $$;
revoke execute on function ensure_patient_record() from public, anon;
grant execute on function ensure_patient_record() to authenticated, service_role;

-- Booking cap for non-staff callers: at most 5 FUTURE tentative/confirmed appointments that THIS CALLER created for THIS
-- patient (the 'created' row in appointment_events records the actor). Staff-made appointments never count against a
-- patient, and a guardian is capped per child. Serialised per caller so parallel requests cannot both pass. Staff exempt.
-- Reschedules are net zero and are not capped.
create function assert_booking_cap(p_patient uuid) returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if is_booking_staff() then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('booking_cap:' || auth.uid()::text, 0));
  if (select count(*) from appointments a
        join appointment_events e on e.appointment_id = a.id and e.event = 'created' and e.actor = auth.uid()
       where a.patient_id = p_patient and a.status in ('tentative','confirmed') and a.starts_at > now()) >= 5 then
    raise exception 'too_many_bookings';
  end if;
end $$;
revoke execute on function assert_booking_cap(uuid) from public, anon, authenticated;

-- 0002's assert_bookable plus, for non-staff: a 60-day horizon (practice timezone, inclusive) and the session type's buffer:
-- the new range widened by p_buffer_min on both sides must not touch another tentative/confirmed appointment ('slot_taken')
-- or blocked time ('blocked_time'). This matches how lib/booking/slots.ts hides slots, so a hand-made request cannot squeeze
-- into a buffer the slot list would never offer. Staff are exempt as before.
drop function assert_bookable(timestamptz, timestamptz);
create function assert_bookable(p_start timestamptz, p_end timestamptz, p_buffer_min int default 0) returns void
language plpgsql stable set search_path = public, pg_temp as $$
declare tz text; ls timestamp; le timestamp; buf interval := make_interval(mins => greatest(coalesce(p_buffer_min, 0), 0));
begin
  if is_booking_staff() then return; end if;
  if p_start <= now() then raise exception 'start_in_past'; end if;
  select timezone into tz from practices limit 1;
  ls := p_start at time zone tz; le := p_end at time zone tz;
  if ls::date > (now() at time zone tz)::date + 60 then raise exception 'beyond_horizon'; end if;
  if exists (select 1 from blocked_times where starts_at < p_end + buf and ends_at > p_start - buf) then raise exception 'blocked_time'; end if;
  if ls::date <> le::date or not exists (
       select 1 from availability_rules
       where weekday = extract(dow from ls)::int and start_time <= ls::time and end_time >= le::time) then
    raise exception 'outside_hours';
  end if;
  if exists (select 1 from appointments where status in ('tentative','confirmed') and starts_at < p_end + buf and ends_at > p_start - buf) then
    raise exception 'slot_taken';
  end if;
end $$;
revoke execute on function assert_bookable(timestamptz, timestamptz, int) from public, anon, authenticated;

create or replace function book_appointment(p_patient uuid, p_type uuid, p_start timestamptz, p_status text default 'confirmed') returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare dur int; buf int; new_id uuid; v_status text;
begin
  perform assert_patient_access(p_patient);
  if is_booking_staff() then
    if p_status is null or p_status not in ('confirmed','tentative') then raise exception 'invalid_status'; end if;
    v_status := p_status;
  else -- R19: the practice's approval mode decides, never the caller
    select case when approval_mode = 'auto' then 'confirmed' else 'tentative' end into v_status from practices limit 1;
  end if;
  select duration_min, buffer_min into dur, buf from session_types where id = p_type and active;
  if dur is null then raise exception 'unknown_session_type'; end if;
  perform assert_bookable(p_start, p_start + make_interval(mins => dur), buf);
  perform assert_booking_cap(p_patient);
  begin
    insert into appointments(patient_id,session_type_id,starts_at,ends_at,status)
    values (p_patient,p_type,p_start,p_start + make_interval(mins => dur),v_status) returning id into new_id;
  exception when exclusion_violation then raise exception 'slot_taken';
  end;
  return new_id; end $$;

-- Same as 0002 except: no booking cap (a move is net zero), and assert_bookable runs after the old row is released so a
-- shift into an overlapping slot does not collide with the appointment being moved (the whole call rolls back on any error).
create or replace function reschedule_appointment(p_appt uuid, p_new_start timestamptz) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare a appointments; new_id uuid; new_end timestamptz; buf int;
begin
  select * into a from appointments where id = p_appt for update;
  if not found then raise exception 'unknown_appointment'; end if;
  perform assert_patient_access(a.patient_id);
  if a.status not in ('requested','tentative','confirmed') then raise exception 'not_reschedulable'; end if;
  if not is_booking_staff() and a.starts_at <= now() then raise exception 'already_started'; end if;
  new_end := p_new_start + (a.ends_at - a.starts_at);
  select buffer_min into buf from session_types where id = a.session_type_id;
  update appointments set status = 'cancelled', cancelled_by = auth.uid(), cancel_reason = 'rescheduled' where id = p_appt;
  perform assert_bookable(p_new_start, new_end, buf);
  begin
    insert into appointments(patient_id,session_type_id,starts_at,ends_at,status)
    values (a.patient_id, a.session_type_id, p_new_start, new_end, a.status) returning id into new_id;
  exception when exclusion_violation then raise exception 'slot_taken';
  end;
  update appointment_events set detail = detail || jsonb_build_object('rescheduled_from', p_appt)
    where appointment_id = new_id and event = 'created';
  insert into appointment_events(appointment_id,event,actor,detail)
    values (p_appt,'rescheduled',auth.uid(),jsonb_build_object('from',a.starts_at,'to',p_new_start,'new_id',new_id));
  return new_id; end $$;
