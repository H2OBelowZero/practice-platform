-- supabase/migrations/0034_icd10_import.sql
-- Final review (before go-live). Only seven ICD-10 codes were seeded (0005) and no API role may write icd10_codes (insert/update/delete revoked from
-- authenticated and service_role), so a claim could never carry any other diagnosis code. The practice loads the South African ICD-10 Master Industry
-- Table (MIT, published through the Council for Medical Schemes) with scripts/import-icd10.mjs, which calls this function with the SERVICE key, in batches.
--
-- import_icd10_codes(p_codes jsonb): p_codes is an array of {code, description}, 1 to 1000 elements. Every element is checked FIRST, and any problem
-- rejects the whole batch (nothing is written): 'invalid_batch', 'invalid_code: <code>' (letter, two digits, optionally a dot and one or two letters or
-- digits, e.g. F32, F32.9, M54.56), 'invalid_description: <code>' (1 to 500 characters after trimming), 'duplicate_code: <code>' (twice in the batch).
-- Codes are stored upper case and trimmed. Existing codes get the new description only when it differs. Codes are never deleted (claims refer to them).
-- Returns the counts inserted / updated / unchanged and writes one audit row ('icd10.import', counts only).
-- SECURITY DEFINER, search_path public, pg_temp; executable by service_role only (not even the psychologist calls it from the app).

create function import_icd10_codes(p_codes jsonb) returns table (inserted int, updated int, unchanged int)
language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
declare e jsonb; v_code text; v_desc text; seen text[] := '{}'; n int; v_ins int; v_upd int;
begin
  if p_codes is null or jsonb_typeof(p_codes) <> 'array' or jsonb_array_length(p_codes) not between 1 and 1000 then raise exception 'invalid_batch'; end if;
  for e in select value from jsonb_array_elements(p_codes) loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'code') is distinct from 'string' or jsonb_typeof(e -> 'description') is distinct from 'string' then
      raise exception 'invalid_batch'; end if;
    v_code := upper(btrim(e ->> 'code'));
    v_desc := btrim(e ->> 'description', E' \t\r\n');
    if v_code !~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,2})?$' then raise exception 'invalid_code: %', left(v_code, 20); end if;
    if char_length(v_desc) not between 1 and 500 then raise exception 'invalid_description: %', v_code; end if;
    if v_code = any (seen) then raise exception 'duplicate_code: %', v_code; end if;
    seen := seen || v_code;
  end loop;
  n := cardinality(seen);
  with src as (
    select upper(btrim(x ->> 'code')) as code, btrim(x ->> 'description', E' \t\r\n') as description from jsonb_array_elements(p_codes) x),
  up as (
    insert into icd10_codes as k (code, description) select s.code, s.description from src s
    on conflict (code) do update set description = excluded.description where k.description is distinct from excluded.description
    returning (xmax = 0) as is_new)
  select count(*) filter (where is_new)::int, count(*) filter (where not is_new)::int into v_ins, v_upd from up;
  perform audit_write('icd10.import', 'icd10_codes', null, jsonb_build_object('received', n, 'inserted', v_ins, 'updated', v_upd));
  return query select v_ins, v_upd, n - v_ins - v_upd;
end $$;
revoke execute on function import_icd10_codes(jsonb) from public, anon, authenticated;
grant execute on function import_icd10_codes(jsonb) to service_role;
