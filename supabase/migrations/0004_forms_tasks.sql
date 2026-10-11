-- supabase/migrations/0004_forms_tasks.sql
create table form_templates (id uuid primary key default gen_random_uuid(), key text not null, version int not null, schema jsonb not null, active boolean not null default true, unique(key,version));
create table form_submissions (id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  template_id uuid not null references form_templates, template_version int not null, answers jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft','submitted','returned')), submitted_at timestamptz, submitted_by uuid, updated_at timestamptz not null default now());
-- every transition to 'submitted' leaves an immutable snapshot of what was submitted
create table form_submission_versions (id bigserial primary key, submission_id uuid not null references form_submissions,
  event text not null check (event in ('submitted')), answers jsonb not null, template_version int not null, actor uuid, at timestamptz not null default now());
create table consents (id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  purpose text not null check (purpose in ('treatment','privacy_notice','telehealth','financial_terms','share_referrer','share_insurer')),
  granted boolean not null, granted_at timestamptz, withdrawn_at timestamptz, form_submission_id uuid references form_submissions, template_version int,
  unique(patient_id,purpose));
create table tasks (id uuid primary key default gen_random_uuid(), title text not null, due_at timestamptz, priority text not null default 'normal' check (priority in ('low','normal','high')),
  status text not null default 'open' check (status in ('open','done')), assignee uuid references auth.users, patient_id uuid references patients,
  appointment_id uuid references appointments, source text, created_at timestamptz not null default now());
create table notifications_outbox (id bigserial primary key, channel text not null check (channel in ('email','sms','push')), template text not null,
  recipient text not null, payload jsonb not null default '{}', status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts int not null default 0, send_after timestamptz not null default now());
create table retention_policies (record_type text primary key, retain_years int, legal_hold boolean not null default false);

-- The patient themself, or a current guardian holding permissions.forms (read and write of forms and consents).
create function can_access_forms(p_patient uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as
$$ select exists (select 1 from patients where id = p_patient and user_id = auth.uid())
       or exists (select 1 from guardianships where patient_id = p_patient and guardian_user_id = auth.uid()
                  and valid_from <= current_date and (valid_to is null or valid_to >= current_date)
                  and permissions ->> 'forms' = 'true') $$;

-- Submissions. template_version always follows the template; the DB decides the lifecycle and attribution:
-- patients/guardians insert as draft only (active template); identity columns are frozen; every transition to 'submitted'
-- stamps submitted_at = now() and submitted_by = auth.uid() (caller-supplied values are ignored, staff included);
-- a submitted form is frozen (only staff may return it for correction, answers untouched).
create function fs_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare tpl form_templates;
        v_staff boolean := auth.uid() is null or coalesce(auth_role()::text, '') in ('psychologist','admin');
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    select * into tpl from form_templates where id = new.template_id;
    if tpl.id is not null then new.template_version := tpl.version; end if;
    if not v_staff then
      if new.status <> 'draft' or new.submitted_at is not null or new.submitted_by is not null then raise exception 'submission must be created as a draft'; end if;
      if tpl.id is null or not tpl.active then raise exception 'template_not_active'; end if;
    end if;
    new.submitted_at := case when new.status = 'submitted' then now() end;
    new.submitted_by := case when new.status = 'submitted' then auth.uid() end;
    return new;
  end if;
  if new.id is distinct from old.id or new.patient_id is distinct from old.patient_id
     or new.template_id is distinct from old.template_id or new.template_version is distinct from old.template_version then
    raise exception 'protected submission columns cannot be changed'; end if;
  if old.status = 'submitted' then
    if not (v_staff and new.status = 'returned' and new.answers = old.answers
            and new.submitted_at is not distinct from old.submitted_at and new.submitted_by is not distinct from old.submitted_by) then
      raise exception 'submission is immutable'; end if;
    perform audit_write('form.return', 'form_submissions', new.id);
    return new;
  end if;
  if not ((old.status, new.status) in (('draft','draft'),('draft','submitted'),('returned','returned'),('returned','submitted'))) then
    raise exception 'invalid_status_transition'; end if;
  if new.status = 'submitted' then new.submitted_at := now(); new.submitted_by := auth.uid();
  elsif new.submitted_at is distinct from old.submitted_at or new.submitted_by is distinct from old.submitted_by then
    raise exception 'protected submission columns cannot be changed'; end if;
  return new; end $$;
create trigger trg_fs_guard before insert or update on form_submissions for each row execute function fs_guard();

-- snapshot + audit on every transition to 'submitted' (after the row exists, so the snapshot's FK holds)
create function fs_after() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status is distinct from 'submitted') then
    insert into form_submission_versions(submission_id,event,answers,template_version,actor)
    values (new.id, 'submitted', new.answers, new.template_version, auth.uid());
    perform audit_write('form.submit', 'form_submissions', new.id,
      jsonb_build_object('patient_id', new.patient_id, 'template_id', new.template_id, 'template_version', new.template_version));
  end if;
  return null; end $$;
create trigger trg_fs_after after insert or update on form_submissions for each row execute function fs_after();
create trigger trg_fsv_append_only before update or delete on form_submission_versions for each row execute function append_only_guard();

-- submissions are evidence: never deleted by anyone (privileges are also revoked below)
create function fs_no_delete() returns trigger language plpgsql as
$$ begin raise exception 'form_submissions cannot be deleted'; end $$;
create trigger trg_fs_no_delete before delete on form_submissions for each row execute function fs_no_delete();

-- A template version that any submission references is frozen; changing a form means inserting a new version.
create function ft_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (new.key, new.version, new.schema) is distinct from (old.key, old.version, old.schema)
     and exists (select 1 from form_submissions where template_id = old.id) then
    raise exception 'template_in_use: insert a new version instead'; end if;
  return new; end $$;
create trigger trg_ft_guard before update on form_templates for each row execute function ft_guard();

-- consent history is never deleted (privileges are also revoked below); writes go through set_consent only
create function consents_no_delete() returns trigger language plpgsql as
$$ begin raise exception 'consents cannot be deleted'; end $$;
create trigger trg_consents_no_delete before delete on consents for each row execute function consents_no_delete();

create function set_consent(p_patient uuid, p_purpose text, p_granted boolean, p_submission uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare prev consents; cur consents; v_version int; v_status text; v_found boolean;
begin
  if auth.uid() is not null and coalesce(auth_role()::text, '') not in ('psychologist','admin') and not can_access_forms(p_patient) then
    raise exception 'forbidden'; end if;
  if p_purpose is null or p_purpose not in ('treatment','privacy_notice','telehealth','financial_terms','share_referrer','share_insurer') then
    raise exception 'invalid_purpose'; end if;
  if p_granted is null then raise exception 'invalid_granted'; end if;
  if p_submission is not null then
    select template_version, status into v_version, v_status from form_submissions where id = p_submission and patient_id = p_patient;
    if not found then raise exception 'submission_mismatch'; end if;
    if v_status <> 'submitted' then raise exception 'submission_not_submitted'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_patient::text || p_purpose, 0));
  select * into prev from consents where patient_id = p_patient and purpose = p_purpose;
  v_found := found;
  if not v_found then
    insert into consents(patient_id,purpose,granted,granted_at,withdrawn_at,form_submission_id,template_version)
    values (p_patient, p_purpose, p_granted, case when p_granted then now() end, case when not p_granted then now() end,
            case when p_granted then p_submission end, case when p_granted then v_version end);
  elsif p_granted then
    -- a (re-)grant is a fresh agreement when it was not granted, or when it is backed by a different submission / template version
    if not prev.granted or (p_submission is not null and (p_submission is distinct from prev.form_submission_id or v_version is distinct from prev.template_version)) then
      update consents set granted = true, granted_at = now(), withdrawn_at = null, form_submission_id = p_submission, template_version = v_version where id = prev.id;
    end if;
  elsif prev.granted then -- withdrawal keeps the evidence of what was agreed
    update consents set granted = false, withdrawn_at = now() where id = prev.id;
  end if;
  select * into cur from consents where patient_id = p_patient and purpose = p_purpose;
  if not p_granted and v_found and prev.granted then
    insert into tasks(title,priority,patient_id,source) values ('Consent withdrawn: '||p_purpose,'high',p_patient,'consent_withdrawn'); end if;
  perform audit_write('consent.'||case when p_granted then 'grant' else 'withdraw' end,'consents',p_patient,jsonb_build_object(
    'purpose', p_purpose, 'granted', p_granted, 'template_version', cur.template_version, 'form_submission_id', cur.form_submission_id,
    'previous_granted', case when v_found then prev.granted end, 'previous_granted_at', prev.granted_at, 'previous_withdrawn_at', prev.withdrawn_at,
    'acted_by_role', coalesce(auth_role()::text, 'system')));
end $$;

alter table form_templates enable row level security; alter table form_submissions enable row level security;
alter table consents enable row level security; alter table form_submission_versions enable row level security; alter table tasks enable row level security;
alter table notifications_outbox enable row level security; alter table retention_policies enable row level security;
create policy ft_read on form_templates for select to authenticated using (true);
create policy ft_write on form_templates for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
create policy fs_staff_sel on form_submissions for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy fs_staff_ins on form_submissions for insert to authenticated with check (auth_role() in ('psychologist','admin'));
create policy fs_staff_upd on form_submissions for update to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy fsv_staff on form_submission_versions for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy fsv_own on form_submission_versions for select to authenticated
  using (exists (select 1 from form_submissions s where s.id = submission_id and can_access_forms(s.patient_id)));
create policy fs_own_read on form_submissions for select to authenticated using (can_access_forms(patient_id));
create policy fs_own_write on form_submissions for insert to authenticated with check (can_access_forms(patient_id));
-- WITH CHECK is explicit: without it USING would apply to the new row and block draft -> submitted
create policy fs_own_update on form_submissions for update to authenticated
  using (can_access_forms(patient_id) and status in ('draft','returned')) with check (can_access_forms(patient_id));
create policy co_staff on consents for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy co_own on consents for select to authenticated using (can_access_forms(patient_id));
create policy tk_staff on tasks for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
-- outbox: service role only (no authenticated policies)
create policy rp_psy on retention_policies for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');

-- no anonymous access; consents are written only by set_consent (security definer, runs as owner)
revoke all on form_templates, form_submissions, form_submission_versions, consents, tasks, notifications_outbox, retention_policies from anon;
revoke insert, update, delete on consents from authenticated, service_role;
revoke delete on form_submissions from authenticated, service_role;
revoke insert, update, delete on form_submission_versions from authenticated, service_role; -- written only by fs_after
revoke all on notifications_outbox from authenticated; -- service role only

-- function privileges (ruling R4)
revoke execute on function can_access_forms(uuid) from public, anon;
grant execute on function can_access_forms(uuid) to authenticated, service_role;
revoke execute on function fs_after() from public, anon;
grant execute on function fs_after() to authenticated, service_role;
revoke execute on function ft_guard() from public, anon;
grant execute on function ft_guard() to authenticated, service_role;
revoke execute on function set_consent(uuid, text, boolean, uuid) from public, anon;
grant execute on function set_consent(uuid, text, boolean, uuid) to authenticated, service_role;
