-- supabase/migrations/0031_access_scoping.sql
-- Final review (R50): I2, I3, M1, M2, M3.
--
--  I2  patients.user_id (the link between a patient record and a login) may be changed ONLY by the trusted writer: the table owner, i.e.
--      ensure_patient_record() (0008, SECURITY DEFINER), migrations, and the ON DELETE SET NULL of auth.users (foreign-key actions run as the table
--      owner). Every API role is refused, staff included: until now psychologist and admin were exempt, so an admin could point a patient record at
--      their own login and read the restricted health history through the patient-side policies. Error 'patient_account_link_protected'.
--  I3  profiles (display names and roles): psychologist and admin read every profile; bookkeeper and associate read their own and STAFF profiles only
--      (the "recorded by" labels on billing pages); patients and guardians read only their own. Before, is_staff() let the bookkeeper and associate
--      read every patient's and guardian's display name.
--  M1  No hard deletes of tasks, patients or guardianships through the API (anon, authenticated and service_role lose DELETE; no app code path deletes
--      them). Patients and tasks also get a trigger that refuses DELETE for every writer, the owner included (patients are archived, tasks are marked
--      done). Guardianships are ENDED by setting valid_to; they keep no trigger because ON DELETE CASCADE from auth.users must still work when the owner
--      deletes an account in Supabase Auth (the same is true of profiles).
--  M2  Frozen links. appointments.patient_id / session_type_id (and id, created_at) cannot change through the API once the row exists (a reschedule makes
--      a new row; cancel/reschedule run as the owner and do not touch them): 'appointment_link_frozen'. An invoice's patient_id / appointment_id cannot
--      change through the API at all, draft included (save_invoice_draft never changes them; create_invoice_draft checked the pair when it was created):
--      'invoice_link_frozen'.
--  M3  The associate role has no access to patient data in Phase 1: removed from patients_staff_read (the only patient-data policy that named it).
--      Do not create associate accounts until assigned-patient scoping exists (Phase 3).

-- ---- I2 ------------------------------------------------------------------------------------------------------------------------------------------
-- Same as 0023 except the user_id rule, which now binds every caller that is not the trusted writer.
create or replace function patients_guard() returns trigger language plpgsql set search_path = public, pg_temp as
$$ begin
  if new.user_id is distinct from old.user_id and not _trusted_writer(tg_relid) then
    raise exception 'patient_account_link_protected';
  end if;
  if auth.uid() is not null and coalesce(auth_role()::text, '') not in ('psychologist','admin') and (
       new.id is distinct from old.id
    or new.patient_number is distinct from old.patient_number or new.status is distinct from old.status
    or new.payer is distinct from old.payer or new.is_minor is distinct from old.is_minor
    or new.created_at is distinct from old.created_at
    or new.portal_invited_at is distinct from old.portal_invited_at
    or new.email is distinct from old.email or new.phone is distinct from old.phone) then
    raise exception 'protected patient columns can only be changed by staff';
  end if;
  return new;
end $$;

-- ---- I3 ------------------------------------------------------------------------------------------------------------------------------------------
drop policy profiles_self on profiles;
create policy profiles_self on profiles for select to authenticated using (
  user_id = auth.uid()
  or coalesce(auth_role()::text, '') in ('psychologist', 'admin')
  or (coalesce(auth_role()::text, '') in ('bookkeeper', 'associate') and role in ('psychologist', 'admin', 'bookkeeper', 'associate')));

-- ---- M3 ------------------------------------------------------------------------------------------------------------------------------------------
drop policy patients_staff_read on patients;
create policy patients_staff_read on patients for select to authenticated using (auth_role() in ('psychologist', 'admin'));

-- ---- M1 ------------------------------------------------------------------------------------------------------------------------------------------
revoke delete on tasks, patients, guardianships from anon, authenticated, service_role;
create function no_delete_guard() returns trigger language plpgsql set search_path = public, pg_temp as
$$ begin raise exception '% cannot be deleted', tg_table_name; end $$;
create trigger trg_patients_no_delete before delete on patients for each row execute function no_delete_guard();
create trigger trg_tasks_no_delete before delete on tasks for each row execute function no_delete_guard();
revoke execute on function no_delete_guard() from public, anon, authenticated, service_role;

-- ---- M2 ------------------------------------------------------------------------------------------------------------------------------------------
create function appointments_links_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.id is distinct from old.id or new.patient_id is distinct from old.patient_id or new.session_type_id is distinct from old.session_type_id
      or new.created_at is distinct from old.created_at) and not _trusted_writer(tg_relid) then
    raise exception 'appointment_link_frozen';
  end if;
  return new; end $$;
create trigger trg_appointments_links before update on appointments for each row execute function appointments_links_guard();
revoke execute on function appointments_links_guard() from public, anon;
grant execute on function appointments_links_guard() to authenticated, service_role;

-- invoices_guard: same as 0026 except that patient_id and appointment_id are frozen for API roles from creation on (draft included).
create or replace function invoices_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare api boolean := not _trusted_writer(tg_relid); s bigint;
begin
  if tg_op = 'INSERT' then
    if api and new.status <> 'draft' then raise exception 'invoice_must_start_as_draft'; end if;
  else
    if old.status = 'void' and new.status <> 'void' then raise exception 'invoice_void_is_final'; end if;
    if new.status = 'draft' and old.status <> 'draft' then raise exception 'invalid_invoice_transition'; end if;
    if new.status is distinct from old.status then
      if api and (old.status, new.status) not in (('draft','issued'),('issued','void'),('draft','void')) then
        raise exception 'invalid_invoice_transition'; end if;
      if api and new.status = 'void' and exists (select 1 from payments where invoice_id = old.id and status = 'succeeded') then
        raise exception 'invoice_has_payments'; end if;
      if api and new.status = 'void' and exists (select 1 from credit_notes where invoice_id = old.id) then
        raise exception 'invoice_has_credits'; end if;
      if new.status = 'void' and exists (select 1 from claims where invoice_id = old.id and status in ('submitted','accepted','part_paid','paid')) then
        raise exception 'invoice_has_open_claims'; end if;
    end if;
    if api then
      if new.id is distinct from old.id or new.created_at is distinct from old.created_at or new.number is distinct from old.number then
        raise exception 'invoice_frozen'; end if;
      if new.patient_id is distinct from old.patient_id or new.appointment_id is distinct from old.appointment_id then
        raise exception 'invoice_link_frozen'; end if;
      if old.status <> 'draft' and (
           new.issue_date is distinct from old.issue_date
        or new.subtotal_cents is distinct from old.subtotal_cents or new.discount_cents is distinct from old.discount_cents
        or new.vat_cents is distinct from old.vat_cents or new.total_cents is distinct from old.total_cents
        or new.scheme_portion_cents is distinct from old.scheme_portion_cents or new.patient_portion_cents is distinct from old.patient_portion_cents
        or new.payer_type is distinct from old.payer_type) then
        raise exception 'invoice_frozen'; end if;
    end if;
  end if;
  if new.status in ('issued','part_paid','paid') and (tg_op = 'INSERT' or old.status = 'draft') then
    if new.total_cents = 0 then raise exception 'zero_total'; end if;
    if new.scheme_portion_cents + new.patient_portion_cents <> new.total_cents then raise exception 'portions_mismatch'; end if;
    if new.payer_type = 'self' and new.scheme_portion_cents <> 0 then raise exception 'self_pay_has_scheme_portion'; end if;
    if tg_op = 'UPDATE' then
      if exists (select 1 from invoice_lines where invoice_id = new.id) then
        select coalesce(sum(quantity::bigint * unit_cents), 0) into s from invoice_lines where invoice_id = new.id;
        if s <> new.subtotal_cents or new.discount_cents > new.subtotal_cents
           or new.subtotal_cents - new.discount_cents + new.vat_cents <> new.total_cents then
          raise exception 'lines_mismatch'; end if;
      end if;
      new.issue_date := sa_today();
    end if;
  end if;
  return new; end $$;
