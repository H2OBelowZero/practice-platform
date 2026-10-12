-- supabase/migrations/0013_notes_hardening.sql
-- Task 12 fix round 1.
--  1. Risk-flag tasks (source 'risk_flag:<note id>') are clinical: readable and writable by the psychologist ONLY (the admin sees none and cannot create,
--     change or delete one). All other tasks stay psychologist + admin.
--  2. tasks.meta (jsonb) holds {level} for a risk task; one risk task per note (partial unique index); raise_risk_task() creates it atomically, raises it
--     when the level rises and re-opens a finished one only then.
--  3. A note's appointment must belong to the note's patient, and an appointment has at most one note.
--  4. note_versions are throttled (same author within 5 minutes => no new row) but the text at the moment of signing is always kept.
--  5. note.* audit rows carry the patient id (an id, never text) so the patient's Audit tab can find them.

-- 1. policies ---------------------------------------------------------------------------------------------------------------------------------
alter table tasks add column meta jsonb;
drop policy tk_staff on tasks;
create policy tk_staff on tasks for all to authenticated
  using (auth_role() in ('psychologist','admin') and coalesce(source,'') not like 'risk_flag:%')
  with check (auth_role() in ('psychologist','admin') and coalesce(source,'') not like 'risk_flag:%');
create policy tk_risk on tasks for all to authenticated
  using (auth_role() = 'psychologist' and source like 'risk_flag:%')
  with check (auth_role() = 'psychologist' and source like 'risk_flag:%');

-- 2. one risk task per note ---------------------------------------------------------------------------------------------------------------------
create unique index tasks_risk_flag_once on tasks (source) where source like 'risk_flag:%';

-- Raise (or raise again) the follow-up task for a moderate/high risk flag. security invoker: the caller's RLS decides (psychologist only).
-- none/low do nothing; a lower level never touches an existing task; a finished task is re-opened only when the level goes from moderate to high.
create function raise_risk_task(p_note uuid, p_level text, p_title text) returns void language plpgsql security invoker set search_path = public, pg_temp as $$
declare n clinical_notes; t tasks; src text := 'risk_flag:' || p_note;
begin
  if p_level is null or p_level not in ('moderate','high') then return; end if;
  select * into n from clinical_notes where id = p_note;
  if not found then raise exception 'note_not_found'; end if;
  insert into tasks(title, priority, patient_id, appointment_id, source, assignee, meta)
  values (p_title, 'high', n.patient_id, n.appointment_id, src, auth.uid(), jsonb_build_object('level', p_level))
  on conflict (source) where source like 'risk_flag:%' do nothing;
  if found then return; end if;
  select * into t from tasks where source = src;
  if found and p_level = 'high' and coalesce(t.meta->>'level','moderate') = 'moderate' then
    update tasks set title = p_title, priority = 'high', status = 'open', meta = jsonb_build_object('level', 'high') where id = t.id;
  end if;
end $$;
revoke execute on function raise_risk_task(uuid, text, text) from public, anon;
grant execute on function raise_risk_task(uuid, text, text) to authenticated, service_role;

-- 3. integrity ----------------------------------------------------------------------------------------------------------------------------------
create unique index clinical_notes_appointment_once on clinical_notes (appointment_id) where appointment_id is not null;

-- notes_guard: 0003 plus (a) appointment/patient match, (b) throttled draft versions with a guaranteed version at signing, (c) patient id in the audit detail.
create or replace function notes_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare lv record;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' or new.signed_at is not null then raise exception 'note must be created as a draft'; end if;
    if new.appointment_id is not null and not exists (select 1 from appointments where id = new.appointment_id and patient_id = new.patient_id) then
      raise exception 'appointment_patient_mismatch'; end if;
    return new; end if;
  if tg_op = 'DELETE' then raise exception 'note is immutable'; end if; -- clinical records are retained, drafts included
  if new.id is distinct from old.id or new.patient_id is distinct from old.patient_id
     or new.author_id is distinct from old.author_id or new.created_at is distinct from old.created_at then
    raise exception 'note is immutable'; end if;
  if old.state = 'draft' then
    if new.appointment_id is not null and new.appointment_id is distinct from old.appointment_id
       and not exists (select 1 from appointments where id = new.appointment_id and patient_id = new.patient_id) then
      raise exception 'appointment_patient_mismatch'; end if;
    if new.state = 'signed' then
      if old.author_id is distinct from auth.uid() then raise exception 'not_author'; end if; -- also rejects uid-less callers
      new.signed_at := now();
      perform audit_write('note.sign','clinical_notes',new.id, jsonb_build_object('patient_id', new.patient_id));
    elsif new.state <> 'draft' then raise exception 'invalid_state_transition';
    elsif new.signed_at is not null then raise exception 'signed_at is set only by sign_note'; end if;
    if new.content is distinct from old.content or new.state = 'signed' then
      select content, saved_by, saved_at into lv from note_versions where note_id = old.id order by version_no desc limit 1;
      if new.state = 'signed' then
        -- signing always keeps the last draft text unless the newest version already holds exactly it
        if lv is null or lv.content is distinct from old.content then
          insert into note_versions(note_id,version_no,content,saved_by)
          values (old.id, coalesce((select max(version_no) from note_versions where note_id = old.id),0)+1, old.content, auth.uid());
        end if;
      elsif lv is null or lv.saved_by is distinct from auth.uid() or lv.saved_at < now() - interval '5 minutes' then
        -- throttle: the same person saving again within 5 minutes does not add a version row
        insert into note_versions(note_id,version_no,content,saved_by)
        values (old.id, coalesce((select max(version_no) from note_versions where note_id = old.id),0)+1, old.content, auth.uid());
      end if;
    end if;
  else
    if new.content is distinct from old.content or new.risk is distinct from old.risk or new.template_id is distinct from old.template_id
       or new.appointment_id is distinct from old.appointment_id or new.signed_at is distinct from old.signed_at then
      raise exception 'note is immutable'; end if;
    if new.state is distinct from old.state and not (old.state = 'signed' and new.state = 'amended'
         and exists (select 1 from note_addenda where note_id = new.id)) then
      raise exception 'invalid_state_transition'; end if;
  end if;
  return new; end $$;

-- 5. addendum audit with the patient id
create or replace function addenda_after() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid;
begin
  update clinical_notes set state = 'amended' where id = new.note_id and state = 'signed';
  select patient_id into pid from clinical_notes where id = new.note_id;
  perform audit_write('note.addendum','clinical_notes',new.note_id, jsonb_build_object('patient_id', pid));
  return null; end $$;
