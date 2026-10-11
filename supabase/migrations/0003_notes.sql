-- supabase/migrations/0003_notes.sql
create table note_templates (id uuid primary key default gen_random_uuid(), name text not null, schema jsonb not null, active boolean default true);
insert into note_templates(name,schema) values
 ('SOAP','{"fields":["subjective","objective","assessment","plan"]}'),
 ('DAP','{"fields":["data","assessment","plan"]}'),
 ('Free form','{"fields":["notes"]}');
create table clinical_notes (
  id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  appointment_id uuid references appointments, template_id uuid references note_templates,
  state text not null default 'draft' check (state in ('draft','signed','amended')),
  content jsonb not null default '{}', risk jsonb not null default '{}',
  author_id uuid not null, signed_at timestamptz, created_at timestamptz not null default now());
-- notes are never deleted (see notes_guard), so versions need no cascade
create table note_versions (id bigserial primary key, note_id uuid not null references clinical_notes,
  version_no int not null, content jsonb not null, saved_by uuid, saved_at timestamptz not null default now(),
  unique (note_id, version_no));
create table note_addenda (id uuid primary key default gen_random_uuid(), note_id uuid not null references clinical_notes,
  content text not null check (length(btrim(content)) > 0), author_id uuid not null, created_at timestamptz not null default now());

-- Immutability + state machine for clinical notes; applies to every caller including the owner.
-- Allowed transitions: draft -> signed (sign_note), signed/amended -> amended (add_addendum).
-- sign_note / add_addendum raise a single-use transaction-local flag (app.note_op) that this guard consumes.
-- ponytail: a caller can set the flag themselves, but only to sign/amend their own note without an audit row; use a
-- security definer sign_note if that ever matters.
create function notes_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare op text := coalesce(current_setting('app.note_op', true), '');
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' or new.signed_at is not null then raise exception 'note must be created as a draft'; end if;
    return new; end if;
  if tg_op = 'DELETE' then raise exception 'note is immutable'; end if; -- clinical records are retained, drafts included
  perform set_config('app.note_op', '', true);
  if new.id is distinct from old.id or new.patient_id is distinct from old.patient_id
     or new.author_id is distinct from old.author_id or new.created_at is distinct from old.created_at then
    raise exception 'note is immutable'; end if;
  if old.state = 'draft' then
    if new.state = 'signed' and op = 'sign' then new.signed_at := now();
    elsif new.state <> 'draft' then raise exception 'invalid_state_transition';
    elsif new.signed_at is not null then raise exception 'signed_at is set only by sign_note'; end if;
    if new.content is distinct from old.content then
      insert into note_versions(note_id,version_no,content,saved_by)
      values (old.id, coalesce((select max(version_no) from note_versions where note_id = old.id),0)+1, old.content, auth.uid());
    end if;
  else
    if new.content is distinct from old.content or new.risk is distinct from old.risk or new.template_id is distinct from old.template_id
       or new.appointment_id is distinct from old.appointment_id or new.signed_at is distinct from old.signed_at then
      raise exception 'note is immutable'; end if;
    if new.state is distinct from old.state and not (new.state = 'amended' and op = 'addendum') then
      raise exception 'invalid_state_transition'; end if;
  end if;
  return new; end $$;
create trigger trg_notes_guard before insert or update or delete on clinical_notes for each row execute function notes_guard();

-- versions and addenda are append-only; addenda only on signed/amended notes (checked under the caller's RLS)
create function append_only_guard() returns trigger language plpgsql as
$$ begin raise exception '% is append-only', tg_table_name; end $$;
create trigger note_versions_no_change before update or delete on note_versions for each row execute function append_only_guard();
create trigger note_addenda_no_change before update or delete on note_addenda for each row execute function append_only_guard();
create function addenda_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from clinical_notes where id = new.note_id and state in ('signed','amended')) then
    raise exception 'note_not_signed'; end if;
  return new; end $$;
create trigger note_addenda_on_signed before insert on note_addenda for each row execute function addenda_guard();

create function sign_note(p_note uuid) returns void language plpgsql security invoker set search_path = public, pg_temp as $$
declare a uuid; s text;
begin
  select author_id, state into a, s from clinical_notes where id = p_note for update;
  if not found or a is distinct from auth.uid() then raise exception 'not_author'; end if; -- invisible notes look the same
  if s <> 'draft' then raise exception 'note not draftable'; end if;
  perform set_config('app.note_op', 'sign', true);
  update clinical_notes set state='signed' where id=p_note;
  perform set_config('app.note_op', '', true);
  perform audit_write('note.sign','clinical_notes',p_note); end $$;
create function add_addendum(p_note uuid, p_content text) returns void language plpgsql security invoker set search_path = public, pg_temp as $$
declare s text;
begin
  select state into s from clinical_notes where id = p_note for update;
  if not found then raise exception 'note_not_found'; end if;
  if s = 'draft' then raise exception 'note_not_signed'; end if;
  insert into note_addenda(note_id,content,author_id) values (p_note,p_content,auth.uid());
  perform set_config('app.note_op', 'addendum', true);
  update clinical_notes set state='amended' where id=p_note and state in ('signed','amended');
  perform set_config('app.note_op', '', true);
  perform audit_write('note.addendum','clinical_notes',p_note); end $$;

alter table note_templates enable row level security; alter table clinical_notes enable row level security;
alter table note_versions enable row level security; alter table note_addenda enable row level security;
create policy nt_read on note_templates for select to authenticated using (is_staff());
-- author_id is forced to the caller on insert only; notes_guard keeps it fixed afterwards, so any psychologist may amend (addendum)
create policy cn_sel on clinical_notes for select to authenticated using (auth_role()='psychologist');
create policy cn_ins on clinical_notes for insert to authenticated with check (auth_role()='psychologist' and author_id = auth.uid());
create policy cn_upd on clinical_notes for update to authenticated using (auth_role()='psychologist') with check (auth_role()='psychologist');
create policy cn_del on clinical_notes for delete to authenticated using (auth_role()='psychologist');
create policy nv_psy on note_versions for select to authenticated using (auth_role()='psychologist');
create policy na_read on note_addenda for select to authenticated using (auth_role()='psychologist');
create policy na_insert on note_addenda for insert to authenticated with check (auth_role()='psychologist' and author_id = auth.uid());

-- no anonymous access; versions are written only by notes_guard, addenda never change after insert
revoke all on note_templates, clinical_notes, note_versions, note_addenda from anon;
revoke insert, update, delete on note_versions from authenticated, service_role;
revoke update, delete on note_addenda from authenticated, service_role;

revoke execute on function notes_guard() from public, anon;
grant execute on function notes_guard() to authenticated, service_role;
revoke execute on function sign_note(uuid) from public, anon;
grant execute on function sign_note(uuid) to authenticated, service_role;
revoke execute on function add_addendum(uuid, text) from public, anon;
grant execute on function add_addendum(uuid, text) to authenticated, service_role;
