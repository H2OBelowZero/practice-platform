-- supabase/migrations/0009_appointment_status_machine.sql
-- Task 10b: appointment status transitions are a state machine enforced by the database, not by whichever screen
-- happens to issue the UPDATE. Applies to every writer (staff via RLS, the cancel/reschedule definer functions, service role, owner).
--   tentative -> confirmed | cancelled
--   confirmed -> attended | no_show | cancelled
--   requested -> tentative | cancelled        (legacy value, unused in Phase 1)
--   attended, no_show, cancelled are terminal
-- INSERT: a row born through the API (auth.uid() is not null, staff included) is 'tentative' or 'confirmed' only.
--   The owner and the service role (auth.uid() is null) may insert any state (imports, tests).
-- Only staff (psychologist / admin) or a trusted writer with no end-user (auth.uid() is null: service role, owner) may mark
-- attended or no_show. Start and end times are frozen on any row that ends up attended, no_show or cancelled
-- (checked on NEW.status, so a combined "set status and move the time" UPDATE is refused too).
-- Invoker function: it only reads auth.uid() and auth_role(), so it needs no elevated rights.
create function appt_status_machine() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new.status not in ('tentative','confirmed') then
      raise exception 'invalid_appointment_transition'; end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if (old.status, new.status) not in (
         ('tentative','confirmed'), ('tentative','cancelled'),
         ('confirmed','attended'), ('confirmed','no_show'), ('confirmed','cancelled'),
         ('requested','tentative'), ('requested','cancelled')) then
      raise exception 'invalid_appointment_transition'; end if;
    if new.status in ('attended','no_show') and auth.uid() is not null
       and coalesce(auth_role()::text, '') not in ('psychologist','admin') then
      raise exception 'invalid_appointment_transition'; end if;
  end if;
  if new.status in ('attended','no_show','cancelled')
     and (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at) then
    raise exception 'appointment_times_frozen'; end if;
  return new; end $$;
create trigger trg_appt_status_machine before insert or update on appointments for each row execute function appt_status_machine();

revoke execute on function appt_status_machine() from public, anon;
grant execute on function appt_status_machine() to authenticated, service_role;
