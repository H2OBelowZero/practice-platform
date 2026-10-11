-- supabase/migrations/0004_forms_tasks.sql
create table form_templates (id uuid primary key default gen_random_uuid(), key text not null, version int not null, schema jsonb not null, active boolean not null default true, unique(key,version));
create table form_submissions (id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  template_id uuid not null references form_templates, template_version int not null, answers jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft','submitted','returned')), submitted_at timestamptz, updated_at timestamptz not null default now());
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

-- Submissions. template_version always follows the template; for patients/guardians the DB decides the lifecycle:
-- insert as draft only (active template), identity columns frozen, draft|returned -> submitted stamps submitted_at,
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
      if new.status <> 'draft' or new.submitted_at is not null then raise exception 'submission must be created as a draft'; end if;
      if tpl.id is null or not tpl.active then raise exception 'template_not_active'; end if;
    elsif new.status = 'submitted' then new.submitted_at := coalesce(new.submitted_at, now());
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.patient_id is distinct from old.patient_id
     or new.template_id is distinct from old.template_id or new.template_version is distinct from old.template_version then
    raise exception 'protected submission columns cannot be changed'; end if;
  if old.status = 'submitted' then
    if not (v_staff and new.status = 'returned' and new.answers = old.answers and new.submitted_at is not distinct from old.submitted_at) then
      raise exception 'submission is immutable'; end if;
    perform audit_write('form.return', 'form_submissions', new.id);
    return new;
  end if;
  if not ((old.status, new.status) in (('draft','draft'),('draft','submitted'),('returned','returned'),('returned','submitted'))) then
    raise exception 'invalid_status_transition'; end if;
  if new.status = 'submitted' then new.submitted_at := now();
  elsif new.submitted_at is distinct from old.submitted_at then raise exception 'protected submission columns cannot be changed'; end if;
  return new; end $$;
create trigger trg_fs_guard before insert or update on form_submissions for each row execute function fs_guard();

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
declare was_granted boolean; v_version int;
begin
  if auth.uid() is not null and coalesce(auth_role()::text, '') not in ('psychologist','admin') and not can_access_forms(p_patient) then
    raise exception 'forbidden'; end if;
  if p_purpose is null or p_purpose not in ('treatment','privacy_notice','telehealth','financial_terms','share_referrer','share_insurer') then
    raise exception 'invalid_purpose'; end if;
  if p_granted is null then raise exception 'invalid_granted'; end if;
  if p_submission is not null then
    select template_version into v_version from form_submissions where id = p_submission and patient_id = p_patient;
    if not found then raise exception 'submission_mismatch'; end if;
  end if;
  select granted into was_granted from consents where patient_id = p_patient and purpose = p_purpose for update;
  insert into consents(patient_id,purpose,granted,granted_at,withdrawn_at,form_submission_id,template_version)
  values (p_patient, p_purpose, p_granted, case when p_granted then now() end, case when not p_granted then now() end, p_submission, v_version)
  on conflict (patient_id,purpose) do update set granted = excluded.granted,
    granted_at = case when not excluded.granted then consents.granted_at
                      when consents.granted then consents.granted_at else excluded.granted_at end,
    withdrawn_at = case when excluded.granted then null else coalesce(consents.withdrawn_at, excluded.withdrawn_at) end,
    form_submission_id = coalesce(excluded.form_submission_id, consents.form_submission_id),
    template_version = coalesce(excluded.template_version, consents.template_version);
  if not p_granted and coalesce(was_granted, false) then
    insert into tasks(title,priority,patient_id,source) values ('Consent withdrawn: '||p_purpose,'high',p_patient,'consent_withdrawn'); end if;
  perform audit_write('consent.'||case when p_granted then 'grant' else 'withdraw' end,'consents',p_patient,jsonb_build_object('purpose',p_purpose));
end $$;

alter table form_templates enable row level security; alter table form_submissions enable row level security;
alter table consents enable row level security; alter table tasks enable row level security;
alter table notifications_outbox enable row level security; alter table retention_policies enable row level security;
create policy ft_read on form_templates for select to authenticated using (true);
create policy ft_write on form_templates for all to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
create policy fs_staff on form_submissions for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
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
revoke all on form_templates, form_submissions, consents, tasks, notifications_outbox, retention_policies from anon;
revoke insert, update, delete on consents from authenticated, service_role;

-- function privileges (ruling R4)
revoke execute on function can_access_forms(uuid) from public, anon;
grant execute on function can_access_forms(uuid) to authenticated, service_role;
revoke execute on function ft_guard() from public, anon;
grant execute on function ft_guard() to authenticated, service_role;
revoke execute on function set_consent(uuid, text, boolean, uuid) from public, anon;
grant execute on function set_consent(uuid, text, boolean, uuid) to authenticated, service_role;
