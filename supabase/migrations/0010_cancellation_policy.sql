-- supabase/migrations/0010_cancellation_policy.sql
-- Task 10b fix round 1: the cancellation policy is enforced by the database.
--  1. A patient (non-staff) cannot reschedule an appointment that is already inside the practice's cancellation window:
--     they must cancel (which carries the fee rules) or contact the practice. Otherwise "move it far away, then cancel that one
--     for free" would bypass the late fee. Staff are exempt.
--  2. cancel_appointment creates the late-fee TASK itself, in the same transaction as the cancellation (R29: a task, never an invoice),
--     and writes the audit row. Exactly one fee task per appointment (unique partial index).
--       non-staff: late (starts within cancellation_window_hours, or already started) and late_cancel_fee_cents > 0
--       staff:     only when p_charge_fee is true and late_cancel_fee_cents > 0
--     p_charge_fee is ignored for non-staff.

create unique index tasks_late_fee_once on tasks (appointment_id) where source = 'late_cancel_fee';

drop function cancel_appointment(uuid, text);
create function cancel_appointment(p_appt uuid, p_reason text, p_charge_fee boolean default false) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a appointments; v_staff boolean; v_win int; v_fee int; v_late boolean; v_charged int := 0;
begin
  select * into a from appointments where id = p_appt for update;
  if not found then raise exception 'unknown_appointment'; end if;
  perform assert_patient_access(a.patient_id);
  if a.status not in ('requested','tentative','confirmed') then raise exception 'not_cancellable'; end if;
  v_staff := is_booking_staff();
  if not v_staff and a.starts_at <= now() then raise exception 'already_started'; end if;

  select cancellation_window_hours, late_cancel_fee_cents into v_win, v_fee from practices limit 1;
  v_win := coalesce(v_win, 24); v_fee := coalesce(v_fee, 0);
  v_late := a.starts_at <= now() or a.starts_at - now() < make_interval(hours => v_win);

  if v_fee > 0 and ((not v_staff and v_late) or (v_staff and coalesce(p_charge_fee, false))) then
    v_charged := v_fee;
    insert into tasks(title, priority, source, appointment_id, patient_id)
    values ('Late cancellation: review fee', 'high', 'late_cancel_fee', a.id, a.patient_id)
    on conflict (appointment_id) where source = 'late_cancel_fee' do nothing;
  end if;

  update appointments set status = 'cancelled', cancelled_by = auth.uid(), cancel_reason = p_reason where id = p_appt;
  perform audit_write('appointment.cancel', 'appointments', p_appt,
    jsonb_build_object('late', v_late, 'fee_cents', v_charged, 'by_role', coalesce(auth_role()::text, 'service')));
end $$;
revoke execute on function cancel_appointment(uuid, text, boolean) from public, anon;
grant execute on function cancel_appointment(uuid, text, boolean) to authenticated, service_role;

-- Same as 0008 except: (a) non-staff are refused inside the cancellation window (checked after already_started, so a started
-- appointment still reports already_started); (b) a legacy 'requested' row is moved as 'tentative', the only pending state the
-- status machine (0009) lets an API caller insert.
create or replace function reschedule_appointment(p_appt uuid, p_new_start timestamptz) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare a appointments; new_id uuid; new_end timestamptz; buf int; v_win int;
begin
  select * into a from appointments where id = p_appt for update;
  if not found then raise exception 'unknown_appointment'; end if;
  perform assert_patient_access(a.patient_id);
  if a.status not in ('requested','tentative','confirmed') then raise exception 'not_reschedulable'; end if;
  if not is_booking_staff() then
    if a.starts_at <= now() then raise exception 'already_started'; end if;
    select cancellation_window_hours into v_win from practices limit 1;
    if a.starts_at - now() < make_interval(hours => coalesce(v_win, 24)) then raise exception 'inside_cancellation_window'; end if;
  end if;
  new_end := p_new_start + (a.ends_at - a.starts_at);
  select buffer_min into buf from session_types where id = a.session_type_id;
  update appointments set status = 'cancelled', cancelled_by = auth.uid(), cancel_reason = 'rescheduled' where id = p_appt;
  perform assert_bookable(p_new_start, new_end, buf);
  begin
    insert into appointments(patient_id,session_type_id,starts_at,ends_at,status)
    values (a.patient_id, a.session_type_id, p_new_start, new_end, case when a.status = 'requested' then 'tentative' else a.status end)
    returning id into new_id;
  exception when exclusion_violation then raise exception 'slot_taken';
  end;
  update appointment_events set detail = detail || jsonb_build_object('rescheduled_from', p_appt)
    where appointment_id = new_id and event = 'created';
  insert into appointment_events(appointment_id,event,actor,detail)
    values (p_appt,'rescheduled',auth.uid(),jsonb_build_object('from',a.starts_at,'to',p_new_start,'new_id',new_id));
  return new_id; end $$;
