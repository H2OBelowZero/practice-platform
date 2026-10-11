-- supabase/migrations/0001_core.sql
create extension if not exists btree_gist;
create type role_t as enum ('psychologist','admin','bookkeeper','patient','guardian','associate');

create table practices (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My Practice',
  registration_no text, hpcsa_no text,
  timezone text not null default 'Africa/Johannesburg',
  approval_mode text not null default 'request' check (approval_mode in ('auto','request')),
  cancellation_window_hours int not null default 24,
  late_cancel_fee_cents int not null default 0,
  vat_registered boolean not null default false, vat_rate numeric(5,2) not null default 15,
  crisis_text text not null default 'If you are in crisis call SADAG 0800 567 567 or go to the nearest emergency room. This platform is not an emergency service.',
  created_at timestamptz not null default now());
insert into practices default values;

create table profiles (
  user_id uuid primary key references auth.users on delete cascade,
  role role_t not null, display_name text not null, created_at timestamptz not null default now());

create table patients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete set null,
  patient_number serial,
  first_name text not null, last_name text not null, date_of_birth date,
  email text, phone text, language text default 'en',
  comms_prefs jsonb not null default '{"email":true,"sms":false}',
  emergency_contact jsonb, referral_source text, payer text default 'self',
  status text not null default 'prospect' check (status in ('prospect','active','archived')),
  is_minor boolean not null default false,
  created_at timestamptz not null default now());

create table guardianships (
  id uuid primary key default gen_random_uuid(),
  guardian_user_id uuid not null references auth.users on delete cascade,
  patient_id uuid not null references patients on delete cascade,
  permissions jsonb not null default '{"book":true,"forms":true,"pay":true}',
  authority_note text, valid_from date not null default current_date, valid_to date);

create table audit_log (
  id bigserial primary key, actor_id uuid, role text, action text not null,
  entity text, entity_id uuid, detail jsonb, at timestamptz not null default now());

create function auth_role() returns role_t language sql stable security definer set search_path=public as
$$ select role from profiles where user_id = auth.uid() $$;
create function is_staff() returns boolean language sql stable security definer set search_path=public as
$$ select coalesce(auth_role() in ('psychologist','admin','bookkeeper','associate'), false) $$;
create function my_patient_ids() returns setof uuid language sql stable security definer set search_path=public as
$$ select id from patients where user_id = auth.uid()
   union select patient_id from guardianships
     where guardian_user_id = auth.uid() and valid_from <= current_date and (valid_to is null or valid_to >= current_date) $$;

alter table practices enable row level security;
alter table profiles enable row level security;
alter table patients enable row level security;
alter table guardianships enable row level security;
alter table audit_log enable row level security;

create policy practices_read on practices for select to authenticated using (true);
create policy practices_write on practices for update to authenticated using (auth_role() in ('psychologist')) ;
create policy profiles_self on profiles for select to authenticated using (user_id = auth.uid() or is_staff());
create policy patients_staff_read on patients for select to authenticated using (auth_role() in ('psychologist','admin','associate'));
create policy patients_staff_write on patients for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy patients_own on patients for select to authenticated using (id in (select my_patient_ids()));
create policy patients_own_update on patients for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy guardianship_read on guardianships for select to authenticated using (guardian_user_id = auth.uid() or auth_role() in ('psychologist','admin'));
create policy audit_read on audit_log for select to authenticated using (auth_role() = 'psychologist');
create policy audit_insert on audit_log for insert to authenticated with check (actor_id = auth.uid());
-- no update/delete policies: audit_log is append-only
revoke update, delete on audit_log from authenticated, anon;

create function audit_write(p_action text, p_entity text, p_entity_id uuid, p_detail jsonb default null) returns void
language sql security definer set search_path=public as
$$ insert into audit_log(actor_id,role,action,entity,entity_id,detail) values (auth.uid(), auth_role()::text, p_action, p_entity, p_entity_id, p_detail) $$;

-- security definer functions: not callable by public/anon (ruling R4)
revoke execute on function auth_role() from public, anon;
grant execute on function auth_role() to authenticated, service_role;
revoke execute on function is_staff() from public, anon;
grant execute on function is_staff() to authenticated, service_role;
revoke execute on function my_patient_ids() from public, anon;
grant execute on function my_patient_ids() to authenticated, service_role;
revoke execute on function audit_write(text, text, uuid, jsonb) from public, anon;
grant execute on function audit_write(text, text, uuid, jsonb) to authenticated, service_role;
