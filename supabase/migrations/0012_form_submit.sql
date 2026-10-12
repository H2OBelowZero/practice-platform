-- supabase/migrations/0012_form_submit.sql (Task 11b)
-- 1. form_submissions gets created_at and return_note (staff explain what to correct; the patient sees it).
-- 2. fs_guard is extended: answers must stay under 100 kB, return_note is staff-only and required to return a form.
-- 3. submit_form(): submitting a form and recording its consents is ONE transaction (the app cannot half-do it).
-- 4. Restricted templates (schema.restricted = true, the health history): the admin can neither read nor write those submissions.
--    The psychologist is the only staff role that sees them; the patient and guardian keep their own access.

alter table form_submissions add column created_at timestamptz not null default now();
alter table form_submissions add column return_note text;
alter table form_submissions add constraint fs_return_note_len check (return_note is null or char_length(btrim(return_note)) between 1 and 1000);
alter table form_submissions add constraint fs_answers_object check (jsonb_typeof(answers) = 'object');

-- ---- guard ------------------------------------------------------------------------------------------------------------
-- Same rules as 0004 plus: answers size cap (every path, including a plain UPDATE through RLS, so autosave needs no function of its own),
-- return_note written only by staff while returning a submitted form, and frozen otherwise (the latest note stays until the next return).
create or replace function fs_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare tpl form_templates;
        v_staff boolean := auth.uid() is null or coalesce(auth_role()::text, '') in ('psychologist','admin');
begin
  new.updated_at := now();
  if octet_length(new.answers::text) > 102400 then raise exception 'answers_too_large'; end if;
  if tg_op = 'INSERT' then
    select * into tpl from form_templates where id = new.template_id;
    if tpl.id is not null then new.template_version := tpl.version; end if;
    if not v_staff then
      if new.status <> 'draft' or new.submitted_at is not null or new.submitted_by is not null or new.return_note is not null then raise exception 'submission must be created as a draft'; end if;
      if tpl.id is null or not tpl.active then raise exception 'template_not_active'; end if;
    end if;
    new.submitted_at := case when new.status = 'submitted' then now() end;
    new.submitted_by := case when new.status = 'submitted' then auth.uid() end;
    new.created_at := now();
    return new;
  end if;
  if new.id is distinct from old.id or new.patient_id is distinct from old.patient_id
     or new.template_id is distinct from old.template_id or new.template_version is distinct from old.template_version
     or new.created_at is distinct from old.created_at then
    raise exception 'protected submission columns cannot be changed'; end if;
  if old.status = 'submitted' then
    if not (v_staff and new.status = 'returned' and new.answers = old.answers
            and new.submitted_at is not distinct from old.submitted_at and new.submitted_by is not distinct from old.submitted_by) then
      raise exception 'submission is immutable'; end if;
    if new.return_note is null or btrim(new.return_note) = '' then raise exception 'return_note_required'; end if;
    return new;
  end if;
  if not ((old.status, new.status) in (('draft','draft'),('draft','submitted'),('returned','returned'),('returned','submitted'))) then
    raise exception 'invalid_status_transition'; end if;
  if new.return_note is distinct from old.return_note then raise exception 'protected submission columns cannot be changed'; end if;
  if new.status = 'submitted' then new.submitted_at := now(); new.submitted_by := auth.uid();
  elsif new.submitted_at is distinct from old.submitted_at or new.submitted_by is distinct from old.submitted_by then
    raise exception 'protected submission columns cannot be changed'; end if;
  return new; end $$;

-- ---- restricted templates ---------------------------------------------------------------------------------------------------
-- A template whose schema says "restricted": true holds clinical history. Reading the template itself stays open to every signed-in
-- user (the patient needs it to fill the form in); what is restricted is the SUBMISSIONS (answers, snapshots) for the admin.
create function template_restricted(p_template uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce((select schema ->> 'restricted' = 'true' from form_templates where id = p_template), false) $$;
revoke execute on function template_restricted(uuid) from public, anon;
grant execute on function template_restricted(uuid) to authenticated, service_role;

-- psychologist: all submissions; admin: all except restricted templates
create function staff_form_access(p_template uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(auth_role()::text, '') = 'psychologist' or (coalesce(auth_role()::text, '') = 'admin' and not template_restricted(p_template)) $$;
revoke execute on function staff_form_access(uuid) from public, anon;
grant execute on function staff_form_access(uuid) to authenticated, service_role;

drop policy fs_staff_sel on form_submissions;
drop policy fs_staff_ins on form_submissions;
drop policy fs_staff_upd on form_submissions;
drop policy fsv_staff on form_submission_versions;
create policy fs_staff_sel on form_submissions for select to authenticated using (staff_form_access(template_id));
create policy fs_staff_ins on form_submissions for insert to authenticated with check (staff_form_access(template_id));
create policy fs_staff_upd on form_submissions for update to authenticated using (staff_form_access(template_id)) with check (staff_form_access(template_id));
-- snapshots follow their submission (the sub-select is itself filtered by the policies above)
create policy fsv_staff on form_submission_versions for select to authenticated
  using (coalesce(auth_role()::text, '') in ('psychologist','admin') and exists (select 1 from form_submissions s where s.id = submission_id));

-- Mark the seeded health history restricted on databases that already hold it (new databases get it from seed.sql).
-- ft_guard freezes a template version once a submission uses it, so the guard is switched off for this one data fix.
alter table form_templates disable trigger trg_ft_guard;
update form_templates set schema = schema || '{"restricted": true}'::jsonb where key = 'medical_history' and schema ->> 'restricted' is distinct from 'true';
alter table form_templates enable trigger trg_ft_guard;

-- ---- submit_form ------------------------------------------------------------------------------------------------------------
-- Submit an open (draft or returned) form and record the consents it contains, atomically. The app has already validated the answers
-- against the field rules (the database cannot know them); here the database enforces what it can:
--   * the caller is the patient, a guardian with permissions.forms, or staff (staff submit on behalf; audited like any submit);
--     an admin cannot touch a restricted template's submission; anonymous callers are refused
--   * the submission is draft or returned; answers are a JSON object under 100 kB
--   * every purpose is declared as a consent field of THIS submission's template version, none twice, every required consent field
--     is present, and a purpose is listed exactly when its checkbox answer is true
-- Status, submitted_at/by, snapshot and audit all come from the existing triggers; consents go through set_consent itself, so the audit
-- rows and tasks behave exactly as for any other consent. Any failure rolls the whole thing back (the status stays as it was).
create function submit_form(p_submission uuid, p_answers jsonb, p_consent_purposes text[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s form_submissions; tpl form_templates; v_role text := coalesce(auth_role()::text, '');
        purposes text[] := coalesce(p_consent_purposes, '{}'::text[]); f jsonb; p text; listed boolean; checked boolean; declared text[] := '{}';
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;
  select * into s from form_submissions where id = p_submission for update;
  if not found
     or not (v_role in ('psychologist','admin') or can_access_forms(s.patient_id))
     or (v_role = 'admin' and template_restricted(s.template_id)) then raise exception 'forbidden'; end if;
  if s.status not in ('draft','returned') then raise exception 'submission_not_open'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception 'invalid_answers'; end if;
  if octet_length(p_answers::text) > 102400 then raise exception 'answers_too_large'; end if;
  if (select count(distinct x) from unnest(purposes) x) <> cardinality(purposes) then raise exception 'duplicate_consent_purpose'; end if;

  select * into tpl from form_templates where id = s.template_id;
  for f in select * from jsonb_array_elements(case when jsonb_typeof(tpl.schema -> 'fields') = 'array' then tpl.schema -> 'fields' else '[]'::jsonb end) loop
    if f ->> 'consentPurpose' is null then continue; end if;
    p := f ->> 'consentPurpose';
    declared := declared || p;
    listed := p = any (purposes);
    checked := coalesce(p_answers ->> (f ->> 'key') = 'true', false);
    if f ->> 'required' = 'true' and not listed then raise exception 'consent_required_missing'; end if;
    if listed <> checked then raise exception 'consent_answer_mismatch'; end if;
  end loop;
  foreach p in array purposes loop
    if not (p = any (declared)) then raise exception 'consent_not_in_template'; end if;
  end loop;

  update form_submissions set answers = p_answers, status = 'submitted' where id = s.id;
  foreach p in array purposes loop
    perform set_consent(s.patient_id, p, true, s.id);
  end loop;
end $$;
revoke execute on function submit_form(uuid, jsonb, text[]) from public, anon;
grant execute on function submit_form(uuid, jsonb, text[]) to authenticated, service_role;
