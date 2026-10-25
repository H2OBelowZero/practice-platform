-- BEGIN demo data
-- =====================================================================================================================
-- supabase/seed-demo.sql: DEMO DATA. FICTIONAL, THROWAWAY LOCAL / STAGING DATABASES ONLY.
-- NEVER RUN THIS ON PRODUCTION. It is deliberately NOT listed in supabase/config.toml, so `supabase db reset` (local) does not load it, and
-- `db push` never seeds. Load it by hand, on purpose, after supabase/seed.sql (the form templates) and with the explicit opt-in below.
--
-- It creates accounts that all share ONE password that is PUBLIC KNOWLEDGE (it is written right here), including a psychologist. On a
-- project that will hold real data that would be an open door. Every person, address, phone (000 ...), amount and note is invented.
--
--   password for every demo account:  Demo-Passw0rd-2026
--   psychologist@demo.test  admin@demo.test  bookkeeper@demo.test      (staff: TOTP cannot be seeded, enrol it at first sign-in, see README)
--   patient.a@demo.test (Thandi Nkosi)  patient.b@demo.test (Pieter van der Merwe, medical aid)  patient.c@demo.test (Aisha Patel)
--   guardian@demo.test (Lindiwe Dlamini, guardian of the minor patient Sipho Dlamini)
--
-- HOW TO RUN (one session, so the opt-in applies):
--   psql "<connection string of the THROWAWAY database>" -c "set app.demo_seed = 'on'" -f supabase/seed-demo.sql
--   or in the Supabase SQL editor of a throwaway staging project: paste  set app.demo_seed = 'on';  on the first line, then this file, run as one script.
--
-- SAFETY GUARDS (all must hold, otherwise it only raises a NOTICE and does nothing):
--   1. the session setting app.demo_seed is 'on' (an explicit opt-in: a plain run of this file, or of any other seed, does nothing);
--   2. auth.users has no rows;
--   3. practices.name is still the default 'My Practice';
--   4. the form templates from supabase/seed.sql are already loaded.
-- Guards 2 and 3 are NOT enough on their own: a brand-new production project satisfies both. Guard 1 is what protects it, together with the
-- instruction never to run this file there. Before go-live check that no demo user exists (README section 8, G12).
-- Fixed ids are used so the e2e suite (tests/e2e/helpers/roles.ts) can refer to the rows.
-- Everything goes through the paths the app uses (draft -> issued invoices, record_payment, submit_form, cancel_appointment),
-- acting as the psychologist / patient through the same request.jwt.claims setting PostgREST uses.
-- =====================================================================================================================
do $demo$
declare
  pw constant text := 'Demo-Passw0rd-2026';
  psy constant uuid := 'a0000000-0000-4000-8000-000000000001';
  adm constant uuid := 'a0000000-0000-4000-8000-000000000002';
  bk  constant uuid := 'a0000000-0000-4000-8000-000000000003';
  ua  constant uuid := 'a0000000-0000-4000-8000-000000000011';
  ub  constant uuid := 'a0000000-0000-4000-8000-000000000012';
  uc  constant uuid := 'a0000000-0000-4000-8000-000000000013';
  ug  constant uuid := 'a0000000-0000-4000-8000-000000000021';
  pa  constant uuid := 'b0000000-0000-4000-8000-000000000011';
  pb  constant uuid := 'b0000000-0000-4000-8000-000000000012';
  pc  constant uuid := 'b0000000-0000-4000-8000-000000000013';
  pm  constant uuid := 'b0000000-0000-4000-8000-000000000014';
  st_init constant uuid := 'd0000000-0000-4000-8000-000000000001';
  st_fu   constant uuid := 'd0000000-0000-4000-8000-000000000002';
  st_vid  constant uuid := 'd0000000-0000-4000-8000-000000000003';
  ap_past_a constant uuid := 'e0000000-0000-4000-8000-000000000001';
  ap_past_b constant uuid := 'e0000000-0000-4000-8000-000000000002';
  ap_past_m constant uuid := 'e0000000-0000-4000-8000-000000000003';
  ap_fut_a  constant uuid := 'e0000000-0000-4000-8000-000000000004';
  ap_req_c  constant uuid := 'e0000000-0000-4000-8000-000000000005';
  ap_fut_m  constant uuid := 'e0000000-0000-4000-8000-000000000006';
  ap_late_b constant uuid := 'e0000000-0000-4000-8000-000000000007';
  inv_self  constant uuid := 'c0000000-0000-4000-8000-000000000001';
  inv_split constant uuid := 'c0000000-0000-4000-8000-000000000002';
  inv_minor constant uuid := 'c0000000-0000-4000-8000-000000000003';
  inv_ma    constant uuid := 'c0000000-0000-4000-8000-000000000004';
  mem_b     constant uuid := 'f0000000-0000-4000-8000-000000000001';
  claim_b   constant uuid := 'f0000000-0000-4000-8000-000000000002';
  claims_psy constant text := '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
  claims_pa  constant text := '{"sub":"a0000000-0000-4000-8000-000000000011","role":"authenticated"}';
  d date; tpl uuid; r record; v_pw text;
begin
  if coalesce(current_setting('app.demo_seed', true), '') <> 'on' then
    raise notice 'demo seed skipped: not opted in (run  set app.demo_seed = ''on'';  first, on a throwaway database only)';
    return;
  end if;
  if exists (select 1 from auth.users) then
    raise notice 'demo seed skipped: auth.users already has rows (this is not an empty database)';
    return;
  end if;
  if (select name from practices limit 1) is distinct from 'My Practice' then
    raise notice 'demo seed skipped: the practice has already been configured (name is not the default)';
    return;
  end if;

  if not exists (select 1 from form_templates) then
    raise notice 'demo seed skipped: load supabase/seed.sql (the form templates) first';
    return;
  end if;

  create schema if not exists extensions;
  create extension if not exists pgcrypto schema extensions; -- on Supabase it is already installed in "extensions"
  v_pw := extensions.crypt(pw, extensions.gen_salt('bf'));

  -- ---- accounts (the real auth schema: users + email identities) ----------------------------------------------------
  for r in select * from (values
      (psy, 'psychologist@demo.test', 'Dr Naledi Mokoena', 'psychologist'),
      (adm, 'admin@demo.test',        'Zanele Khumalo',    'admin'),
      (bk,  'bookkeeper@demo.test',   'Johan Botha',       'bookkeeper'),
      (ua,  'patient.a@demo.test',    'Thandi Nkosi',      'patient'),
      (ub,  'patient.b@demo.test',    'Pieter van der Merwe', 'patient'),
      (uc,  'patient.c@demo.test',    'Aisha Patel',       'patient'),
      (ug,  'guardian@demo.test',     'Lindiwe Dlamini',   'guardian')) as t(id, email, name, role) loop
    insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                           raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                           confirmation_token, recovery_token, email_change_token_new, email_change,
                           email_change_token_current, phone_change, phone_change_token, reauthentication_token)
    values ('00000000-0000-0000-0000-000000000000', r.id, 'authenticated', 'authenticated', r.email, v_pw, now(),
            '{"provider":"email","providers":["email"]}', jsonb_build_object('name', r.name), now(), now(),
            '', '', '', '', '', '', '', '');
    insert into auth.identities(id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), r.id, r.id::text,
            jsonb_build_object('sub', r.id::text, 'email', r.email, 'email_verified', true, 'phone_verified', false),
            'email', now(), now(), now());
    -- the signup trigger made a 'patient' profile; staff and guardian roles are promoted exactly as the README says
    if r.role <> 'patient' then update profiles set role = r.role::role_t where user_id = r.id; end if;
  end loop;

  -- ---- everything below is done as the psychologist (same mechanism PostgREST uses) ----------------------------------
  perform set_config('request.jwt.claims', claims_psy, true);

  update practices set name = 'Demo Practice', registration_no = 'DEMO-0000/00', hpcsa_no = 'PS 000 0000',
         approval_mode = 'request', cancellation_window_hours = 24, late_cancel_fee_cents = 35000,
         payment_instructions = E'FICTIONAL bank details for the demo only.\nDemo Bank, account name: Demo Practice, account 0000000000, branch 000000.\nUse your invoice number as the payment reference.';

  insert into session_types(id, name, duration_min, fee_cents, format, buffer_min) values
    (st_init, 'Initial consultation', 60, 120000, 'in_person', 10),
    (st_fu,   'Follow-up',            50,  95000, 'in_person', 10),
    (st_vid,  'Video follow-up',      50,  95000, 'video',     10);
  insert into availability_rules(weekday, start_time, end_time)
    select w, time '08:00', time '16:00' from generate_series(1, 5) w;

  -- ---- patients -------------------------------------------------------------------------------------------------------
  insert into patients(id, user_id, first_name, last_name, date_of_birth, email, phone, status, referral_source) values
    (pa, ua, 'Thandi', 'Nkosi', '1988-03-14', 'patient.a@demo.test', '000 000 0101', 'active', 'Word of mouth'),
    (pb, ub, 'Pieter', 'van der Merwe', '1975-11-02', 'patient.b@demo.test', '000 000 0102', 'active', 'GP referral'),
    (pc, uc, 'Aisha', 'Patel', '1995-07-29', 'patient.c@demo.test', '000 000 0103', 'prospect', 'Website');
  insert into patients(id, first_name, last_name, date_of_birth, email, status, is_minor, emergency_contact) values
    (pm, 'Sipho', 'Dlamini', '2014-05-09', 'guardian@demo.test', 'active', true,
     '{"name":"Lindiwe Dlamini","relationship":"Mother","phone":"000 000 0104"}');
  insert into guardianships(guardian_user_id, patient_id, permissions, authority_note)
  values (ug, pm, '{"book":true,"forms":true,"pay":true}', 'Demo: mother and legal guardian');

  -- ---- appointments (weekdays relative to the day the seed runs; Johannesburg time) ----------------------------------
  -- past ones are inserted confirmed, then marked attended (the status machine allows confirmed -> attended)
  d := sa_today() - 7;  d := d - case extract(dow from d)::int when 6 then 1 when 0 then 2 else 0 end;
  insert into appointments(id, patient_id, session_type_id, starts_at, ends_at, status)
  values (ap_past_a, pa, st_fu, (d + time '10:00') at time zone 'Africa/Johannesburg', (d + time '10:50') at time zone 'Africa/Johannesburg', 'confirmed');
  d := sa_today() - 5;  d := d - case extract(dow from d)::int when 6 then 1 when 0 then 2 else 0 end;
  insert into appointments(id, patient_id, session_type_id, starts_at, ends_at, status)
  values (ap_past_b, pb, st_fu, (d + time '11:00') at time zone 'Africa/Johannesburg', (d + time '11:50') at time zone 'Africa/Johannesburg', 'confirmed');
  d := sa_today() - 3;  d := d - case extract(dow from d)::int when 6 then 1 when 0 then 2 else 0 end;
  insert into appointments(id, patient_id, session_type_id, starts_at, ends_at, status)
  values (ap_past_m, pm, st_init, (d + time '12:00') at time zone 'Africa/Johannesburg', (d + time '13:00') at time zone 'Africa/Johannesburg', 'confirmed');
  update appointments set status = 'attended' where id in (ap_past_a, ap_past_b, ap_past_m);
  -- future: one confirmed for A, one tentative request from C (approval mode is 'request'), one confirmed for the minor
  d := sa_today() + 3;  d := d + case extract(dow from d)::int when 6 then 2 when 0 then 1 else 0 end;
  insert into appointments(id, patient_id, session_type_id, starts_at, ends_at, status)
  values (ap_fut_a, pa, st_fu, (d + time '09:00') at time zone 'Africa/Johannesburg', (d + time '09:50') at time zone 'Africa/Johannesburg', 'confirmed');
  d := sa_today() + 5;  d := d + case extract(dow from d)::int when 6 then 2 when 0 then 1 else 0 end;
  insert into appointments(id, patient_id, session_type_id, starts_at, ends_at, status)
  values (ap_req_c, pc, st_init, (d + time '14:00') at time zone 'Africa/Johannesburg', (d + time '15:00') at time zone 'Africa/Johannesburg', 'tentative');
  d := sa_today() + 6;  d := d + case extract(dow from d)::int when 6 then 2 when 0 then 1 else 0 end;
  insert into appointments(id, patient_id, session_type_id, starts_at, ends_at, status)
  values (ap_fut_m, pm, st_fu, (d + time '11:00') at time zone 'Africa/Johannesburg', (d + time '11:50') at time zone 'Africa/Johannesburg', 'confirmed');
  -- a cancelled one inside the cancellation window; staff charging the fee makes cancel_appointment raise the late-fee task
  insert into appointments(id, patient_id, session_type_id, starts_at, ends_at, status)
  values (ap_late_b, pb, st_fu, now() + interval '5 hours', now() + interval '5 hours 50 minutes', 'confirmed');
  perform cancel_appointment(ap_late_b, 'Demo: patient cancelled at short notice', true);

  -- ---- forms and consents for patient A, submitted by the patient herself ------------------------------------------------
  perform set_config('request.jwt.claims', claims_pa, true);
  select id into tpl from form_templates where key = 'informed_consent' and version = 1;
  insert into form_submissions(id, patient_id, template_id, answers, status)
  values ('90000000-0000-4000-8000-000000000001', pa, tpl, '{}', 'draft');
  perform submit_form('90000000-0000-4000-8000-000000000001',
    '{"understood":true,"consent_treatment":true,"typed_name":"Thandi Nkosi"}', array['treatment']);
  select id into tpl from form_templates where key = 'privacy_notice' and version = 1;
  insert into form_submissions(id, patient_id, template_id, answers, status)
  values ('90000000-0000-4000-8000-000000000002', pa, tpl, '{}', 'draft');
  perform submit_form('90000000-0000-4000-8000-000000000002', '{"read_notice":true}', array['privacy_notice']);
  perform set_config('request.jwt.claims', claims_psy, true);

  -- ---- invoices: always a draft first, lines, then issue --------------------------------------------------------------
  insert into invoices(id, patient_id, appointment_id, payer_type, subtotal_cents, total_cents, scheme_portion_cents, patient_portion_cents)
  values (inv_self, pa, ap_past_a, 'self', 95000, 95000, 0, 95000);
  insert into invoice_lines(invoice_id, description, quantity, unit_cents, position) values (inv_self, 'Follow-up consultation (50 min)', 1, 95000, 1);
  update invoices set status = 'issued' where id = inv_self;
  -- a part payment by EFT, recorded exactly as the staff screen does
  perform record_payment(inv_self, 'eft', 40000, 'DEMO-EFT-0001', null, sa_today() - 2, false);

  insert into invoices(id, patient_id, appointment_id, payer_type, subtotal_cents, total_cents, scheme_portion_cents, patient_portion_cents)
  values (inv_split, pb, ap_past_b, 'split', 95000, 95000, 76000, 19000);
  insert into invoice_lines(invoice_id, description, quantity, unit_cents, position) values (inv_split, 'Follow-up consultation (50 min)', 1, 95000, 1);
  update invoices set status = 'issued' where id = inv_split;
  insert into medical_aid_members(id, patient_id, scheme, plan, member_number, dependant_code, main_member_name, valid_from)
  values (mem_b, pb, 'Demo Medical Scheme', 'Demo Plan', 'DEMO-0001', '00', 'Pieter van der Merwe', '2024-01-01');
  insert into claims(id, invoice_id, member_id, claimed_cents, icd10_codes) values (claim_b, inv_split, mem_b, 76000, '{F41.1}');
  update claims set status = 'submitted', claim_ref = 'DEMO-CLAIM-0001' where id = claim_b; -- tracked by hand; the invoice stays issued

  insert into invoices(id, patient_id, appointment_id, payer_type, subtotal_cents, total_cents, scheme_portion_cents, patient_portion_cents)
  values (inv_minor, pm, ap_past_m, 'self', 120000, 120000, 0, 120000);
  insert into invoice_lines(invoice_id, description, quantity, unit_cents, position) values (inv_minor, 'Initial consultation (60 min)', 1, 120000, 1);
  update invoices set status = 'issued' where id = inv_minor;

  -- a pure medical-aid invoice (the scheme owes all of it, patient portion 0), written by hand with no appointment
  insert into invoices(id, patient_id, payer_type, subtotal_cents, total_cents, scheme_portion_cents, patient_portion_cents)
  values (inv_ma, pb, 'medical_aid', 95000, 95000, 95000, 0);
  insert into invoice_lines(invoice_id, description, quantity, unit_cents, position) values (inv_ma, 'Follow-up consultation (50 min), billed to the scheme', 1, 95000, 1);
  update invoices set status = 'issued' where id = inv_ma;

  -- ---- a clinical note draft for the attended appointment of patient A (obviously fictional text) ------------------------
  insert into clinical_notes(id, patient_id, appointment_id, template_id, content, author_id)
  select '80000000-0000-4000-8000-000000000001', pa, ap_past_a, t.id,
         '{"subjective":"DEMO TEXT, FICTIONAL. Patient reports a fictional week of mild worry.","objective":"DEMO TEXT. Calm, engaged.","assessment":"DEMO TEXT. No real assessment was made.","plan":"DEMO TEXT. Fictional follow-up in one week."}'::jsonb,
         psy
    from note_templates t where t.name = 'SOAP';

  perform set_config('request.jwt.claims', '', true);
  raise notice 'demo seed loaded: 7 demo accounts (password in the header of this block), 4 patients, 7 appointments, 4 invoices, 1 claim';
end
$demo$;
-- END demo data
