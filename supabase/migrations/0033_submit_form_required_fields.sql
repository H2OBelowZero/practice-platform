-- supabase/migrations/0033_submit_form_required_fields.sql
-- Final review M5. submit_form() (0012) relied on the app for the field rules, so a direct RPC call (anon key + the patient's own token) could submit,
-- say, the informed consent with an empty typed signature. The database now enforces the field rules it can read from THIS submission's template version:
--   * a required text, textarea or date field has a non-empty string answer, a required select has an answer, a required checkbox is true
--     -> 'required_field_missing: <field key>'
--   * an answer that is given has the right shape: text/textarea/date/select a string, a checkbox true/false, a date a real YYYY-MM-DD date,
--     a select one of its options -> 'invalid_field_value: <field key>'
-- The consent checks of 0012 run first and keep their own errors (consent_required_missing, consent_answer_mismatch, ...). The app keeps its friendlier,
-- per-field validation (lib/forms/validate.ts validateAnswers) in front of this; the length caps stay app-side, the 100 kB total cap is here already.
-- Same function as 0012 otherwise: SECURITY DEFINER, search_path, signature and R4 grants (re-stated).

create or replace function submit_form(p_submission uuid, p_answers jsonb, p_consent_purposes text[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s form_submissions; tpl form_templates; v_role text := coalesce(auth_role()::text, '');
        purposes text[] := coalesce(p_consent_purposes, '{}'::text[]); f jsonb; p text; listed boolean; checked boolean; declared text[] := '{}';
        v jsonb; k text; blank boolean;
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

  -- 0033: required fields and answer shapes (see the header)
  for f in select * from jsonb_array_elements(case when jsonb_typeof(tpl.schema -> 'fields') = 'array' then tpl.schema -> 'fields' else '[]'::jsonb end) loop
    k := f ->> 'key';
    if k is null then continue; end if;
    v := p_answers -> k;
    if f ->> 'type' = 'checkbox' then
      if v is not null and v <> 'null'::jsonb and jsonb_typeof(v) <> 'boolean' then raise exception 'invalid_field_value: %', k; end if;
      if f ->> 'required' = 'true' and v is distinct from 'true'::jsonb then raise exception 'required_field_missing: %', k; end if;
      continue;
    end if;
    blank := v is null or v = 'null'::jsonb or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}', E' \t\r\n') = '');
    if blank then
      if f ->> 'required' = 'true' then raise exception 'required_field_missing: %', k; end if;
      continue;
    end if;
    if jsonb_typeof(v) <> 'string' then raise exception 'invalid_field_value: %', k; end if;
    if f ->> 'type' = 'select' and not (coalesce(f -> 'options', '[]'::jsonb) ? (v #>> '{}')) then raise exception 'invalid_field_value: %', k; end if;
    if f ->> 'type' = 'date' then
      if (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid_field_value: %', k; end if;
      begin
        perform (v #>> '{}')::date;
      exception when others then raise exception 'invalid_field_value: %', k;
      end;
    end if;
  end loop;

  update form_submissions set answers = p_answers, status = 'submitted' where id = s.id;
  foreach p in array purposes loop
    perform set_consent(s.patient_id, p, true, s.id);
  end loop;
  -- a consent this form declares but the answers leave unticked is withdrawn if it is currently given (same audit and task as any withdrawal);
  -- a purpose that was never given gets no row and no task
  foreach p in array declared loop
    if not (p = any (purposes)) and exists (select 1 from consents where patient_id = s.patient_id and purpose = p and granted) then
      perform set_consent(s.patient_id, p, false, s.id);
    end if;
  end loop;
end $$;
revoke execute on function submit_form(uuid, jsonb, text[]) from public, anon;
grant execute on function submit_form(uuid, jsonb, text[]) to authenticated, service_role;
