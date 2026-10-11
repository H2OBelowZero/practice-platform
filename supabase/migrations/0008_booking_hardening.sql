-- supabase/migrations/0008_booking_hardening.sql
-- Task 10a: buffer sanity, patient-record bootstrap for self-registered users, and a per-caller booking cap.

alter table session_types add constraint session_types_buffer_nonneg check (buffer_min >= 0);

-- A self-registered patient has a profile (signup trigger) but no `patients` row. This returns the caller's row id,
-- creating it on first use. Only role 'patient' (guardians act through guardianships; staff have no patient row).
-- Duplicate avoidance: a staff-created prospect (user_id null) with the same email is linked ONLY when the auth user's
-- email is confirmed, otherwise anybody could register someone else's address and inherit their record.
create function ensure_patient_record() returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); v_role role_t; v_name text; v_email text; v_confirmed timestamptz;
        v_id uuid; v_first text; v_last text;
begin
  if me is null then raise exception 'forbidden'; end if;
  select role, display_name into v_role, v_name from profiles where user_id = me;
  if v_role is distinct from 'patient' then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ensure_patient_record:' || me::text, 0)); -- idempotent under concurrency
  select id into v_id from patients where user_id = me order by created_at, id limit 1;
  if v_id is not null then return v_id; end if;

  select email, email_confirmed_at into v_email, v_confirmed from auth.users where id = me;
  if v_email is not null and v_confirmed is not null then
    select id into v_id from patients where user_id is null and lower(email) = lower(v_email) order by created_at, id limit 1 for update;
    if v_id is not null then
      update patients set user_id = me where id = v_id;
      perform audit_write('patient.link_account', 'patients', v_id);
      return v_id;
    end if;
  end if;

  v_name := btrim(coalesce(v_name, ''), E' \t\r\n');
  v_first := coalesce(nullif(split_part(v_name, ' ', 1), ''), 'Patient');
  v_last := coalesce(nullif(btrim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1), E' \t\r\n'), ''), '-');
  insert into patients(user_id, first_name, last_name, email, status)
  values (me, v_first, v_last, v_email, 'prospect') returning id into v_id;
  perform audit_write('patient.self_create', 'patients', v_id);
  return v_id;
end $$;
revoke execute on function ensure_patient_record() from public, anon;
grant execute on function ensure_patient_record() to authenticated, service_role;

-- Non-staff callers may hold at most 5 future tentative/confirmed appointments (across every patient they can act for).
-- Serialised per caller so two parallel requests cannot both pass the count. Staff are exempt.
create function assert_booking_cap() returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if is_booking_staff() then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('booking_cap:' || auth.uid()::text, 0));
  if (select count(*) from appointments
       where patient_id in (select my_patient_ids()) and status in ('tentative','confirmed') and starts_at > now()) >= 5 then
    raise exception 'too_many_bookings';
  end if;
end $$;
revoke execute on function assert_booking_cap() from public, anon, authenticated;

create or replace function book_appointment(p_patient uuid, p_type uuid, p_start timestamptz, p_status text default 'confirmed') returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare dur int; new_id uuid; v_status text;
begin
  perform assert_patient_access(p_patient);
  if is_booking_staff() then
    if p_status is null or p_status not in ('confirmed','tentative') then raise exception 'invalid_status'; end if;
    v_status := p_status;
  else -- R19: the practice's approval mode decides, never the caller
    select case when approval_mode = 'auto' then 'confirmed' else 'tentative' end into v_status from practices limit 1;
  end if;
  select duration_min into dur from session_types where id = p_type and active;
  if dur is null then raise exception 'unknown_session_type'; end if;
  perform assert_bookable(p_start, p_start + make_interval(mins => dur));
  perform assert_booking_cap();
  begin
    insert into appointments(patient_id,session_type_id,starts_at,ends_at,status)
    values (p_patient,p_type,p_start,p_start + make_interval(mins => dur),v_status) returning id into new_id;
  exception when exclusion_violation then raise exception 'slot_taken';
  end;
  return new_id; end $$;

create or replace function reschedule_appointment(p_appt uuid, p_new_start timestamptz) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare a appointments; new_id uuid; new_end timestamptz;
begin
  select * into a from appointments where id = p_appt for update;
  if not found then raise exception 'unknown_appointment'; end if;
  perform assert_patient_access(a.patient_id);
  if a.status not in ('requested','tentative','confirmed') then raise exception 'not_reschedulable'; end if;
  if not is_booking_staff() and a.starts_at <= now() then raise exception 'already_started'; end if;
  new_end := p_new_start + (a.ends_at - a.starts_at);
  perform assert_bookable(p_new_start, new_end);
  update appointments set status = 'cancelled', cancelled_by = auth.uid(), cancel_reason = 'rescheduled' where id = p_appt;
  perform assert_booking_cap(); -- counted after the old row is released, so a move at the cap still works
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

-- Linking an existing prospect to a freshly confirmed account sets patients.user_id from NULL, which the guard forbids to
-- non-staff. Allow exactly that one transition when the writer is the function owner (inside ensure_patient_record), never
-- for a direct API update. Everything else in the guard is unchanged from 0001.
create or replace function patients_guard() returns trigger language plpgsql as
$$ begin
  if auth.uid() is not null and coalesce(auth_role()::text, '') not in ('psychologist','admin') and (
       new.id is distinct from old.id
    or (new.user_id is distinct from old.user_id and not (old.user_id is null and _trusted_writer(tg_relid)))
    or new.patient_number is distinct from old.patient_number or new.status is distinct from old.status
    or new.payer is distinct from old.payer or new.is_minor is distinct from old.is_minor
    or new.created_at is distinct from old.created_at) then
    raise exception 'protected patient columns can only be changed by staff';
  end if;
  return new;
end $$;
