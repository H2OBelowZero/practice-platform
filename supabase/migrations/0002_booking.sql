-- supabase/migrations/0002_booking.sql
create table session_types (
  id uuid primary key default gen_random_uuid(), name text not null,
  duration_min int not null check (duration_min > 0), fee_cents int not null check (fee_cents >= 0),
  format text not null default 'in_person' check (format in ('in_person','video')),
  buffer_min int not null default 10, deposit_cents int not null default 0, active boolean not null default true);
create table availability_rules (
  id uuid primary key default gen_random_uuid(), weekday int not null check (weekday between 0 and 6),
  start_time time not null, end_time time not null check (end_time > start_time));
create table blocked_times (
  id uuid primary key default gen_random_uuid(), starts_at timestamptz not null, ends_at timestamptz not null check (ends_at > starts_at), reason text);
create table appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients, session_type_id uuid not null references session_types,
  starts_at timestamptz not null, ends_at timestamptz not null check (ends_at > starts_at),
  status text not null default 'confirmed' check (status in ('requested','tentative','confirmed','attended','no_show','cancelled')),
  cancelled_by uuid, cancel_reason text, created_at timestamptz not null default now(),
  constraint no_overlap exclude using gist (tstzrange(starts_at, ends_at, '[)') with &&)
    where (status in ('tentative','confirmed')));
create table appointment_events (
  id bigserial primary key, appointment_id uuid not null references appointments on delete cascade,
  event text not null, actor uuid, detail jsonb, at timestamptz not null default now());

create function appt_events() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into appointment_events(appointment_id,event,actor,detail)
    values (new.id,'created',auth.uid(),jsonb_build_object('status',new.status,'starts_at',new.starts_at));
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into appointment_events(appointment_id,event,actor) values (new.id,'status:'||new.status,auth.uid());
  end if;
  if new.starts_at is distinct from old.starts_at then
    insert into appointment_events(appointment_id,event,actor,detail)
    values (new.id,'rescheduled',auth.uid(),jsonb_build_object('from',old.starts_at,'to',new.starts_at));
  end if;
  return new; end $$;
create trigger trg_appt_events after insert or update on appointments for each row execute function appt_events();

-- history is never deleted: cancel instead
create function appt_no_delete() returns trigger language plpgsql as
$$ begin raise exception 'appointments cannot be deleted; cancel instead'; end $$;
create trigger trg_appt_no_delete before delete on appointments for each row execute function appt_no_delete();

-- Staff for booking purposes: the service role / superuser (auth.uid() is null) or psychologist/admin.
-- Internal invoker helpers, only called from the security definer functions below.
create function is_booking_staff() returns boolean language sql stable set search_path = public, pg_temp as
$$ select auth.uid() is null or coalesce(auth_role()::text, '') in ('psychologist','admin') $$;

-- Staff pass; otherwise the caller must own the patient, or be a current guardian holding permissions.book (R5, R19).
create function assert_patient_access(p_patient uuid) returns void language plpgsql stable set search_path = public, pg_temp as $$
begin
  if is_booking_staff() then return; end if;
  if exists (select 1 from patients where id = p_patient and user_id = auth.uid())
     or exists (select 1 from guardianships where patient_id = p_patient and guardian_user_id = auth.uid()
                and valid_from <= current_date and (valid_to is null or valid_to >= current_date)
                and permissions ->> 'book' = 'true') then
    return;
  end if;
  raise exception 'forbidden'; end $$;

-- Time sanity for non-staff callers: future, not blocked, inside an availability window (practice timezone).
-- availability_rules.weekday follows extract(dow): 0 = Sunday.
create function assert_bookable(p_start timestamptz, p_end timestamptz) returns void language plpgsql stable set search_path = public, pg_temp as $$
declare tz text; ls timestamp; le timestamp;
begin
  if is_booking_staff() then return; end if;
  if p_start <= now() then raise exception 'start_in_past'; end if;
  if exists (select 1 from blocked_times where starts_at < p_end and ends_at > p_start) then raise exception 'blocked_time'; end if;
  select timezone into tz from practices limit 1;
  ls := p_start at time zone tz; le := p_end at time zone tz;
  if ls::date <> le::date or not exists (
       select 1 from availability_rules
       where weekday = extract(dow from ls)::int and start_time <= ls::time and end_time >= le::time) then
    raise exception 'outside_hours';
  end if; end $$;

create function book_appointment(p_patient uuid, p_type uuid, p_start timestamptz, p_status text default 'confirmed') returns uuid
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
  begin
    insert into appointments(patient_id,session_type_id,starts_at,ends_at,status)
    values (p_patient,p_type,p_start,p_start + make_interval(mins => dur),v_status) returning id into new_id;
  exception when exclusion_violation then raise exception 'slot_taken';
  end;
  return new_id; end $$;

create function cancel_appointment(p_appt uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a appointments;
begin
  select * into a from appointments where id = p_appt for update;
  if not found then raise exception 'unknown_appointment'; end if;
  perform assert_patient_access(a.patient_id);
  if a.status not in ('requested','tentative','confirmed') then raise exception 'not_cancellable'; end if;
  if not is_booking_staff() and a.starts_at <= now() then raise exception 'already_started'; end if;
  update appointments set status = 'cancelled', cancelled_by = auth.uid(), cancel_reason = p_reason where id = p_appt;
end $$;

-- Accepted deviation (R19): the old row is cancelled first, then the new one inserted, atomically. Inserting first would
-- make a shift into an overlapping slot (08:00 -> 08:30) collide with the appointment being moved. A slot_taken error
-- aborts the whole call, so the original stays untouched either way.
create function reschedule_appointment(p_appt uuid, p_new_start timestamptz) returns uuid
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

alter table session_types enable row level security; alter table availability_rules enable row level security;
alter table blocked_times enable row level security; alter table appointments enable row level security;
alter table appointment_events enable row level security;
create policy st_read on session_types for select using (true);
create policy st_write on session_types for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
create policy ar_read on availability_rules for select using (true);
create policy ar_write on availability_rules for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
create policy bt_staff on blocked_times for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy ap_staff on appointments for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy ap_own on appointments for select to authenticated using (patient_id in (select my_patient_ids()));
create policy ae_staff on appointment_events for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy ae_own on appointment_events for select to authenticated using (appointment_id in (select id from appointments where patient_id in (select my_patient_ids())));
-- public slot availability is computed server-side from a security-definer view of busy ranges only (no patient data)
create function busy_ranges(p_from timestamptz, p_to timestamptz) returns table(starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  if p_to - p_from > interval '62 days' then raise exception 'window_too_large'; end if;
  return query
    select a.starts_at, a.ends_at from appointments a where a.status in ('tentative','confirmed') and a.starts_at < p_to and a.ends_at > p_from
    union all select b.starts_at, b.ends_at from blocked_times b where b.starts_at < p_to and b.ends_at > p_from;
end $$;

-- function privileges (ruling R4)
revoke execute on function appt_events() from public, anon;
grant execute on function appt_events() to authenticated, service_role;
revoke execute on function is_booking_staff() from public, anon, authenticated;
revoke execute on function assert_patient_access(uuid) from public, anon, authenticated;
revoke execute on function assert_bookable(timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function book_appointment(uuid, uuid, timestamptz, text) from public, anon;
grant execute on function book_appointment(uuid, uuid, timestamptz, text) to authenticated, service_role;
revoke execute on function cancel_appointment(uuid, text) from public, anon;
grant execute on function cancel_appointment(uuid, text) to authenticated, service_role;
revoke execute on function reschedule_appointment(uuid, timestamptz) from public, anon;
grant execute on function reschedule_appointment(uuid, timestamptz) to authenticated, service_role;
revoke execute on function busy_ranges(timestamptz, timestamptz) from public;
grant execute on function busy_ranges(timestamptz, timestamptz) to anon, authenticated, service_role;
