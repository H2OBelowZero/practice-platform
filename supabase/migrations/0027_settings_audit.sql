-- supabase/migrations/0027_settings_audit.sql
-- Task 16c (R41, R44-R46). Settings: database guards, atomic working-hours editing, default retention rows and an audit trigger on every settings table.
--
--  1. CHECK constraints so no client (the app, PostgREST, the SQL editor) can store a nonsense setting. The database is empty or seeded only, so they are added directly.
--  2. availability_rules: two windows on the same weekday may not overlap (exclusion constraint, error name 'overlapping_hours'); whole minutes only.
--  3. set_day_availability(weekday, windows): replaces one weekday's windows in ONE transaction, SECURITY INVOKER (RLS and the guard below decide who may), and touches
--     only the windows that really changed, so saving an unchanged day leaves no audit rows.
--  4. Default retention rows (no retain_years = "keep indefinitely", no legal hold). Informational only: nothing is deleted automatically in Phase 1.
--  5. settings_audit(): ONE audit_log row for every row change on practices, session_types, availability_rules, blocked_times and retention_policies.
--     action 'settings.change', entity = table, entity_id = the row id (retention_policies has a text key: entity_id null and detail.key), actor and role of the caller,
--     detail = { op, fields } where fields are column NAMES only. Values are NEVER stored (payment instructions, crisis text and fees can be sensitive or free text).
--     A change to practices.payment_instructions (the EFT-fraud vector) is flagged detail.sensitive = true and ALSO writes a second row, 'settings.payment_instructions'.
--     An UPDATE that changes nothing writes nothing. A caller with no auth.uid() (the owner, service role) is still audited, with an empty actor.

-- 1. guards -----------------------------------------------------------------------------------------------------------------------------------------------------
alter table practices
  add constraint practices_name_len check (char_length(btrim(name)) between 1 and 120),
  add constraint practices_registration_len check (registration_no is null or char_length(registration_no) <= 40),
  add constraint practices_hpcsa_len check (hpcsa_no is null or char_length(hpcsa_no) <= 40),
  add constraint practices_crisis_len check (char_length(btrim(crisis_text)) between 1 and 1000),
  add constraint practices_payment_len check (char_length(payment_instructions) <= 1500),
  add constraint practices_window_range check (cancellation_window_hours between 0 and 336),
  add constraint practices_late_fee_range check (late_cancel_fee_cents between 0 and 1000000),
  add constraint practices_vat_range check (vat_rate between 0 and 100);

alter table session_types
  add constraint session_types_name_len check (char_length(btrim(name)) between 1 and 120),
  add constraint session_types_duration_range check (duration_min between 5 and 240),
  add constraint session_types_fee_range check (fee_cents between 0 and 1000000),
  add constraint session_types_buffer_max check (buffer_min <= 120),
  add constraint session_types_deposit_range check (deposit_cents >= 0 and deposit_cents <= fee_cents);

alter table blocked_times add constraint blocked_times_reason_len check (reason is null or char_length(reason) <= 200);

alter table retention_policies
  add constraint retention_record_type_len check (char_length(btrim(record_type)) between 1 and 60),
  add constraint retention_years_range check (retain_years is null or retain_years between 1 and 100);

-- 2. working hours: whole minutes, no overlap on one weekday (touching windows, 08:00-12:00 and 12:00-17:00, are fine) ----------------------------------------------
alter table availability_rules
  add constraint availability_whole_minutes check (extract(second from start_time) = 0 and extract(second from end_time) = 0),
  add constraint overlapping_hours exclude using gist (
    weekday with =,
    int4range((extract(hour from start_time) * 60 + extract(minute from start_time))::int, (extract(hour from end_time) * 60 + extract(minute from end_time))::int, '[)') with &&);

-- 3. replace one weekday's windows atomically -------------------------------------------------------------------------------------------------------------------
-- p_windows = [{"start":"08:00","end":"12:30"}, ...] (HH:MM in the practice's wall-clock time, 5-minute steps, at most 8, an empty array = closed that day).
-- weekday follows extract(dow): 0 = Sunday. Errors: forbidden, invalid_weekday, invalid_windows, invalid_time, invalid_window, overlapping_hours.
create function set_day_availability(p_weekday int, p_windows jsonb) returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
declare w jsonb; s time; e time; ws time[] := '{}'; we time[] := '{}'; i int; j int;
begin
  if auth.uid() is not null and coalesce(auth_role()::text, '') <> 'psychologist' then raise exception 'forbidden'; end if;
  if p_weekday is null or p_weekday not between 0 and 6 then raise exception 'invalid_weekday'; end if;
  if p_windows is null or jsonb_typeof(p_windows) <> 'array' or jsonb_array_length(p_windows) > 8 then raise exception 'invalid_windows'; end if;
  for w in select value from jsonb_array_elements(p_windows) loop
    if jsonb_typeof(w) <> 'object' or coalesce(jsonb_typeof(w -> 'start'), '') <> 'string' or coalesce(jsonb_typeof(w -> 'end'), '') <> 'string'
       or (w ->> 'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (w ->> 'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'invalid_time';
    end if;
    s := (w ->> 'start')::time; e := (w ->> 'end')::time;
    if extract(minute from s)::int % 5 <> 0 or extract(minute from e)::int % 5 <> 0 then raise exception 'invalid_time'; end if;
    if e <= s then raise exception 'invalid_window'; end if;
    ws := ws || s; we := we || e;
  end loop;
  for i in 1 .. coalesce(cardinality(ws), 0) loop
    for j in i + 1 .. cardinality(ws) loop
      if ws[i] < we[j] and ws[j] < we[i] then raise exception 'overlapping_hours'; end if;
    end loop;
  end loop;
  -- only the difference is written (delete first, so a replacement window never meets the window it replaces)
  delete from availability_rules a where a.weekday = p_weekday
    and not exists (select 1 from unnest(ws, we) as t(s, e) where t.s = a.start_time and t.e = a.end_time);
  insert into availability_rules(weekday, start_time, end_time)
    select p_weekday, t.s, t.e from unnest(ws, we) as t(s, e)
    where not exists (select 1 from availability_rules a where a.weekday = p_weekday and a.start_time = t.s and a.end_time = t.e);
end $$;
revoke execute on function set_day_availability(int, jsonb) from public, anon;
grant execute on function set_day_availability(int, jsonb) to authenticated, service_role;

-- 4. default retention rows (before the audit trigger exists, so seeding writes no audit rows) -------------------------------------------------------------------
insert into retention_policies(record_type, retain_years, legal_hold) values
  ('clinical_notes', null, false), ('forms_consents', null, false), ('financial_records', null, false), ('audit_log', null, false), ('communications', null, false)
on conflict (record_type) do nothing;

-- 5. audit trigger ---------------------------------------------------------------------------------------------------------------------------------------------
create function settings_audit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  n jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  r jsonb := coalesce(n, o);
  v_fields text[];
  v_id uuid := case when tg_table_name = 'retention_policies' then null else (r ->> 'id')::uuid end;
  v_detail jsonb;
  v_actor uuid := auth.uid();
  v_role text := auth_role()::text;
begin
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}') into v_fields from jsonb_object_keys(r) as k where (o -> k) is distinct from (n -> k);
    if cardinality(v_fields) = 0 then return null; end if; -- nothing changed: nothing to record
  else
    select array_agg(k order by k) into v_fields from jsonb_object_keys(r) as k;
  end if;
  v_detail := jsonb_build_object('op', lower(tg_op), 'fields', to_jsonb(v_fields));
  if tg_table_name = 'retention_policies' then v_detail := v_detail || jsonb_build_object('key', r ->> 'record_type'); end if;
  if tg_table_name = 'practices' and 'payment_instructions' = any (v_fields) then
    v_detail := v_detail || '{"sensitive": true}'::jsonb;
    insert into audit_log(actor_id, role, action, entity, entity_id, detail)
      values (v_actor, v_role, 'settings.payment_instructions', tg_table_name, v_id, v_detail);
  end if;
  insert into audit_log(actor_id, role, action, entity, entity_id, detail)
    values (v_actor, v_role, 'settings.change', tg_table_name, v_id, v_detail);
  return null;
end $$;
revoke execute on function settings_audit() from public, anon, authenticated, service_role;

create trigger trg_settings_audit after insert or update or delete on practices for each row execute function settings_audit();
create trigger trg_settings_audit after insert or update or delete on session_types for each row execute function settings_audit();
create trigger trg_settings_audit after insert or update or delete on availability_rules for each row execute function settings_audit();
create trigger trg_settings_audit after insert or update or delete on blocked_times for each row execute function settings_audit();
create trigger trg_settings_audit after insert or update or delete on retention_policies for each row execute function settings_audit();
