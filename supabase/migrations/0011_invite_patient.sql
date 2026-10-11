-- supabase/migrations/0011_invite_patient.sql
-- Task 11a fix round 1: inviting a patient to the portal (R28) is one staff-only function, throttled by the database clock.
-- A patient who can be invited has an email, no account yet, is not archived and is not flagged a minor. Inviting again within
-- 10 minutes of the last invitation raises 'invite_too_soon' (stops a double click or a bored hand from mailing the same person repeatedly).
-- It sets portal_invited_at = now() (the database clock, not the app server's) and returns the new timestamp. The caller then queues the
-- email and, if that fails, puts the previous timestamp back.
create function invite_patient(p_patient uuid) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare p patients; ts timestamptz;
begin
  if auth.uid() is null or coalesce(auth_role()::text, '') not in ('psychologist', 'admin') then raise exception 'forbidden'; end if;
  select * into p from patients where id = p_patient for update;
  if not found then raise exception 'patient_not_found'; end if;
  if p.user_id is not null then raise exception 'already_registered'; end if;
  if p.status = 'archived' then raise exception 'patient_archived'; end if;
  if p.is_minor then raise exception 'patient_minor'; end if;
  if p.email is null or btrim(p.email) = '' then raise exception 'no_email'; end if;
  if p.portal_invited_at is not null and p.portal_invited_at > now() - interval '10 minutes' then raise exception 'invite_too_soon'; end if;
  ts := now();
  update patients set portal_invited_at = ts where id = p_patient;
  return ts;
end $$;
revoke execute on function invite_patient(uuid) from public, anon;
grant execute on function invite_patient(uuid) to authenticated, service_role;
