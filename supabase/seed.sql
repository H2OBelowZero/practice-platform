-- supabase/seed.sql
-- FICTIONAL / DRAFT WORDING — to be reviewed by the practice and a legal advisor before live use
-- Local and staging only. Do not run against a live project until the wording has been reviewed.
-- The form templates between the BEGIN/END markers are GENERATED from lib/forms/templates.ts: edit that file, then run
-- `UPDATE_SEED=1 npm run test:unit` (tests/unit/forms-templates.test.ts). Anything outside the markers (Task 17 adds demo data) is left alone.
-- Version 1 of every intake form and consent. Safe to run more than once (existing key + version rows are left alone).

-- BEGIN generated form templates
insert into form_templates(key, version, schema) values ('registration', 1, $tpl${
  "title": "Registration",
  "intro": "Please tell us a little about yourself so that we can set up your file.\n\nOnly the items marked required must be answered. You can leave the rest for your first session if you prefer.",
  "fields": [
    {
      "key": "preferred_name",
      "label": "What name would you like us to use?",
      "type": "text",
      "help": "If it is different from your name on the booking."
    },
    {
      "key": "pronouns",
      "label": "Your pronouns",
      "type": "text",
      "help": "Optional."
    },
    {
      "key": "contact_preference",
      "label": "How do you prefer to be contacted?",
      "type": "select",
      "required": true,
      "options": [
        "Email",
        "SMS or WhatsApp message",
        "Phone call"
      ]
    },
    {
      "key": "safe_to_leave_message",
      "label": "Is it safe for us to leave a voicemail or message on your phone?",
      "type": "select",
      "required": true,
      "options": [
        "Yes",
        "No, please do not leave messages"
      ]
    },
    {
      "key": "home_address",
      "label": "Home address",
      "type": "textarea",
      "help": "Used for your account and, for online sessions, in an emergency."
    },
    {
      "key": "occupation",
      "label": "Occupation or school",
      "type": "text"
    },
    {
      "key": "reason_for_visit",
      "label": "What brings you to therapy at this time?",
      "type": "textarea",
      "required": true,
      "help": "A few sentences is plenty. You can say more in your first session."
    },
    {
      "key": "previous_therapy",
      "label": "Have you seen a psychologist, counsellor or psychiatrist before?",
      "type": "select",
      "required": true,
      "options": [
        "No",
        "Yes"
      ]
    },
    {
      "key": "how_heard",
      "label": "How did you hear about the practice?",
      "type": "text"
    },
    {
      "key": "gp_name",
      "label": "Name of your GP or other doctor",
      "type": "text",
      "help": "Optional. We will only contact them if you give us permission."
    },
    {
      "key": "emergency_name",
      "label": "Emergency contact: full name",
      "type": "text",
      "required": true,
      "help": "Someone we may contact if we are worried about your safety."
    },
    {
      "key": "emergency_phone",
      "label": "Emergency contact: phone number",
      "type": "text",
      "required": true
    },
    {
      "key": "emergency_relationship",
      "label": "Emergency contact: how are they related to you?",
      "type": "text",
      "required": true
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;

insert into form_templates(key, version, schema) values ('medical_history', 1, $tpl${
  "title": "Health history",
  "restricted": true,
  "intro": "This helps your psychologist understand your overall health. Your answers are health information, which the law treats as special personal information, and they are kept confidential as described in our privacy notice.\n\nIf you are in crisis, call SADAG on 0800 567 567 or go to the nearest emergency room. This form is not monitored in real time.",
  "fields": [
    {
      "key": "health_conditions",
      "label": "Current medical conditions",
      "type": "textarea",
      "required": true,
      "help": "For example diabetes, epilepsy, thyroid problems, chronic pain. Write \"none\" if there are none."
    },
    {
      "key": "medications",
      "label": "Medication and supplements you take",
      "type": "textarea",
      "required": true,
      "help": "Name and dose if you know it. Write \"none\" if there are none."
    },
    {
      "key": "allergies",
      "label": "Allergies",
      "type": "textarea",
      "required": true,
      "help": "Write \"none\" if there are none."
    },
    {
      "key": "past_treatment",
      "label": "Mental health treatment in the past",
      "type": "select",
      "required": true,
      "options": [
        "None",
        "Counselling or therapy",
        "Psychiatric medication",
        "Admitted to hospital or a clinic",
        "More than one of these",
        "I would rather talk about this in session"
      ]
    },
    {
      "key": "past_treatment_details",
      "label": "Anything you would like us to know about that treatment",
      "type": "textarea",
      "help": "Optional."
    },
    {
      "key": "sleep",
      "label": "How have you been sleeping lately?",
      "type": "select",
      "required": true,
      "options": [
        "Well",
        "Some difficulty",
        "Poorly",
        "It varies a lot"
      ]
    },
    {
      "key": "alcohol",
      "label": "Alcohol use",
      "type": "select",
      "required": true,
      "options": [
        "None",
        "Occasional",
        "Regular",
        "I would rather talk about this in session"
      ]
    },
    {
      "key": "other_substances",
      "label": "Other substances (including cannabis, and medicine used in ways not prescribed)",
      "type": "select",
      "required": true,
      "options": [
        "None",
        "Occasional",
        "Regular",
        "I would rather talk about this in session"
      ]
    },
    {
      "key": "self_harm_thoughts",
      "label": "In the past two weeks, have you had thoughts of harming yourself or of ending your life?",
      "type": "select",
      "required": true,
      "help": "If you are in crisis, call SADAG on 0800 567 567 or go to the nearest emergency room. This form is not monitored in real time.",
      "options": [
        "No",
        "Sometimes",
        "Often",
        "I would rather talk about this in session"
      ]
    },
    {
      "key": "family_history",
      "label": "Mental health conditions in your close family",
      "type": "textarea",
      "help": "Optional."
    },
    {
      "key": "anything_else",
      "label": "Is there anything else we should know?",
      "type": "textarea"
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;

insert into form_templates(key, version, schema) values ('informed_consent', 1, $tpl${
  "title": "Informed consent to treatment",
  "intro": "Draft wording — to be reviewed by the practice and a legal advisor before live use.\n\nPlease read this carefully. If anything is unclear, ask your psychologist before you agree.\n\nWhat to expect. Psychological assessment and therapy are collaborative. They can bring relief and new understanding, and they can also stir up difficult feelings. We cannot promise a particular result. You may ask questions about your treatment at any time.\n\nYour choice. You take part voluntarily. You may pause or stop therapy at any time, and you may ask for a different approach or a referral to another professional.\n\nConfidentiality. What you tell us is confidential. We keep a clinical record of your sessions. We will only share information about you with your permission, or where the law requires or allows it, for example where there is a serious risk of harm to you or to someone else, a court order, or suspected abuse of a child.\n\nFees and cancellations. Our fees, payment terms and cancellation rules are set out in the separate financial terms.\n\nContact between sessions. Messages are for practical matters such as appointments. This service is not for emergencies.\n\nIf you are in crisis, call SADAG on 0800 567 567 or go to the nearest emergency room. This form is not monitored in real time.",
  "fields": [
    {
      "key": "understood",
      "label": "I have read and understood the information above and my questions have been answered.",
      "type": "checkbox",
      "required": true
    },
    {
      "key": "consent_treatment",
      "label": "I consent to psychological assessment and treatment by this practice.",
      "type": "checkbox",
      "required": true,
      "consentPurpose": "treatment",
      "help": "You can withdraw this consent at any time by telling the practice."
    },
    {
      "key": "typed_name",
      "label": "Type your full name as your signature",
      "type": "text",
      "required": true
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;

insert into form_templates(key, version, schema) values ('privacy_notice', 1, $tpl${
  "title": "Privacy notice",
  "intro": "Draft wording — to be reviewed by the practice and a legal advisor before live use.\n\nThis notice explains how the practice looks after your personal information, in line with the Protection of Personal Information Act (POPIA).\n\nWhat we collect. Your name, contact details, date of birth, billing details, and the health information you give us in forms and sessions, including our clinical notes. Health information is special personal information and gets extra care.\n\nWhy we use it. To assess and treat you, to run appointments and billing, to claim from your medical aid if you ask us to, to communicate with you, and to meet our legal and professional duties.\n\nWho sees it. Your psychologist and the practice staff who need it for their work. Clinical notes are visible only to your psychologist. We use secure service providers (for example for hosting and email) who may only use your information on our instructions. We do not sell your information, and we only share it with others with your consent or where the law requires it.\n\nHow long we keep it. For as long as the law and our professional body require, and then we dispose of it securely.\n\nYour rights. You may ask to see your information, ask us to correct it, ask us to delete what we are not required to keep, object to some uses, and withdraw consent you have given. Withdrawing consent does not affect what we did before you withdrew. You may also complain to the Information Regulator.\n\nQuestions or requests: contact the practice using the details on our website or in your confirmation emails.",
  "fields": [
    {
      "key": "read_notice",
      "label": "I have read this privacy notice and I agree that the practice may process my personal information, including my health information, as described.",
      "type": "checkbox",
      "required": true,
      "consentPurpose": "privacy_notice",
      "help": "You can withdraw this consent later from the Privacy page of your account."
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;

insert into form_templates(key, version, schema) values ('telehealth_consent', 1, $tpl${
  "title": "Consent to online and telephone sessions",
  "intro": "Draft wording — to be reviewed by the practice and a legal advisor before live use.\n\nSome sessions may take place by video or phone. Please read the points below.\n\nPrivacy. Choose a private space where you will not be overheard or interrupted. Please do not record sessions. We will not record them either unless we agree this with you in writing.\n\nTechnology. Connections can drop or be of poor quality. If a video session fails, we will try the phone number you have given us.\n\nSafety. Online sessions are not suitable in a crisis. At the start of each session, please tell us where you are, so that we can get help to you if there is an emergency.\n\nLimits. Online sessions are not right for everyone. Your psychologist may recommend in-person sessions if online work is not helping.",
  "fields": [
    {
      "key": "consent_telehealth",
      "label": "I consent to online and telephone sessions and I understand the points above.",
      "type": "checkbox",
      "required": true,
      "consentPurpose": "telehealth"
    },
    {
      "key": "private_space",
      "label": "I will join from a private space.",
      "type": "checkbox",
      "required": true
    },
    {
      "key": "usual_location",
      "label": "Where will you usually join from?",
      "type": "textarea",
      "required": true,
      "help": "Street address or area. Used only if we need to send help to you in an emergency."
    },
    {
      "key": "backup_phone",
      "label": "Best phone number if a video session drops",
      "type": "text",
      "required": true
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;

insert into form_templates(key, version, schema) values ('financial_terms', 1, $tpl${
  "title": "Fees and payment terms",
  "intro": "Draft wording — to be reviewed by the practice and a legal advisor before live use.\n\nPlease read how fees and payment work.\n\nFees. The fee for each session type is shown when you book. Fees may be reviewed from time to time and we will tell you before a change applies to you. Reports, letters and forms are charged separately and we will tell you the cost first.\n\nPayment. Payment is due on the day of the session, or by the due date on your invoice. You may pay online or by EFT. You remain responsible for the account even if you claim from a medical aid.\n\nMedical aid. Medical aid rates and benefits vary, and some plans do not pay for every session. Claims are made at your request. Anything your scheme does not pay is for your account.\n\nCancellations. Please give notice when you need to cancel or move an appointment. The notice period is shown when you book and when you cancel. A late cancellation or a missed appointment may be charged, as shown at the time.",
  "fields": [
    {
      "key": "accept_terms",
      "label": "I have read and I accept the fees and payment terms.",
      "type": "checkbox",
      "required": true,
      "consentPurpose": "financial_terms"
    },
    {
      "key": "account_holder",
      "label": "Who will be responsible for paying the account?",
      "type": "select",
      "required": true,
      "options": [
        "Myself",
        "Someone else (I will give their details below)"
      ]
    },
    {
      "key": "account_holder_details",
      "label": "Name and contact details of the person responsible for the account",
      "type": "textarea",
      "help": "Only if it is someone other than you."
    },
    {
      "key": "medical_aid",
      "label": "Do you plan to claim from a medical aid?",
      "type": "select",
      "required": true,
      "options": [
        "No, I will pay privately",
        "Yes, I will claim myself",
        "Yes, please submit claims for me"
      ]
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;

insert into form_templates(key, version, schema) values ('guardian_info', 1, $tpl${
  "title": "Parent or guardian information",
  "intro": "Please complete this form if you are the parent or legal guardian of a child or young person who will be seeing us.\n\nChildren's information is kept confidential too. We will talk with you about what your child is comfortable sharing, and what we need to share with you, so that your child can feel safe in therapy.",
  "fields": [
    {
      "key": "guardian_name",
      "label": "Your full name",
      "type": "text",
      "required": true
    },
    {
      "key": "relationship",
      "label": "Your relationship to the child",
      "type": "select",
      "required": true,
      "options": [
        "Mother",
        "Father",
        "Legal guardian",
        "Other"
      ]
    },
    {
      "key": "relationship_other",
      "label": "If other, please describe",
      "type": "text"
    },
    {
      "key": "guardian_phone",
      "label": "Your phone number",
      "type": "text",
      "required": true
    },
    {
      "key": "guardian_email",
      "label": "Your email address",
      "type": "text",
      "required": true
    },
    {
      "key": "has_authority",
      "label": "I have the legal authority to consent to my child's treatment, for example parental responsibilities and rights or a court order.",
      "type": "checkbox",
      "required": true
    },
    {
      "key": "other_guardian",
      "label": "Other person with parental responsibilities, if any (name and contact details)",
      "type": "textarea"
    },
    {
      "key": "court_orders",
      "label": "Any court orders or parenting plans that affect consent, contact or access to information",
      "type": "textarea",
      "required": true,
      "help": "Describe them, or write \"none\"."
    },
    {
      "key": "child_concerns",
      "label": "What are you most concerned about, and what would you like to change?",
      "type": "textarea"
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;

insert into form_templates(key, version, schema) values ('share_with_referrer', 1, $tpl${
  "title": "Permission to share information with the person who referred you",
  "intro": "Draft wording — to be reviewed by the practice and a legal advisor before live use.\n\nThis permission is optional and has no effect on your treatment. If you give it, we may share the information listed below with the person who referred you. We will not share anything else.\n\nYou can change your mind at any time. Withdrawing permission does not affect what was shared before.",
  "fields": [
    {
      "key": "referrer_name",
      "label": "Name of the doctor or other professional",
      "type": "text"
    },
    {
      "key": "referrer_contact",
      "label": "Their email address or phone number",
      "type": "text"
    },
    {
      "key": "share_scope",
      "label": "What may we share?",
      "type": "select",
      "options": [
        "Whether I attend my appointments",
        "Attendance and a short summary of progress",
        "A written report (you will see what it says first)"
      ]
    },
    {
      "key": "share_referrer",
      "label": "I give the practice permission to share the information I selected with this person.",
      "type": "checkbox",
      "consentPurpose": "share_referrer",
      "help": "Leave this unticked if you do not want us to share anything."
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;

insert into form_templates(key, version, schema) values ('share_with_insurer', 1, $tpl${
  "title": "Permission to share information with your medical aid",
  "intro": "Draft wording — to be reviewed by the practice and a legal advisor before live use.\n\nThis permission is optional. If you want us to submit claims to your medical aid, the scheme needs some of your information. This normally includes your name and membership details, the dates and type of sessions, and the diagnosis code for your treatment (an ICD-10 code), which reveals health information.\n\nIf you do not give this permission, we cannot submit claims for you and you will pay the account yourself. You can withdraw permission at any time. Withdrawing does not affect claims already sent.",
  "fields": [
    {
      "key": "scheme_name",
      "label": "Medical aid name and plan",
      "type": "text"
    },
    {
      "key": "member_number",
      "label": "Membership number",
      "type": "text"
    },
    {
      "key": "dependant_code",
      "label": "Your dependant code",
      "type": "text"
    },
    {
      "key": "main_member",
      "label": "Name of the main member, if it is not you",
      "type": "text"
    },
    {
      "key": "share_insurer",
      "label": "I give the practice permission to share the information described above with my medical aid for claims.",
      "type": "checkbox",
      "consentPurpose": "share_insurer",
      "help": "Leave this unticked if you do not want us to share anything."
    }
  ]
}$tpl$::jsonb)
on conflict (key, version) do nothing;
-- END generated form templates

-- BEGIN demo data
-- =====================================================================================================================
-- DEMO DATA. FICTIONAL, LOCAL / STAGING ONLY. Not part of the generated block above (the generator never touches it).
-- Every person, address, amount and note below is invented. All demo accounts share ONE password that is PUBLIC KNOWLEDGE
-- (it is written right here): never load this on a database that holds, or will hold, real accounts.
--
--   password for every demo account:  Demo-Passw0rd-2026
--   psychologist@demo.test  admin@demo.test  bookkeeper@demo.test      (staff: TOTP cannot be seeded, enrol it at first sign-in, see README)
--   patient.a@demo.test (Thandi Nkosi)  patient.b@demo.test (Pieter van der Merwe, medical aid)  patient.c@demo.test (Aisha Patel)
--   guardian@demo.test (Lindiwe Dlamini, guardian of the minor patient Sipho Dlamini)
--
-- SAFETY GUARD: the block below does something ONLY when auth.users has no rows AND practices.name is still the default
-- 'My Practice'. On any configured database (a real user exists, or the practice has been named) it only raises a NOTICE,
-- so running this file against production by accident is a no-op. It also makes the whole file safe to re-run.
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
  mem_b     constant uuid := 'f0000000-0000-4000-8000-000000000001';
  claim_b   constant uuid := 'f0000000-0000-4000-8000-000000000002';
  claims_psy constant text := '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
  claims_pa  constant text := '{"sub":"a0000000-0000-4000-8000-000000000011","role":"authenticated"}';
  d date; tpl uuid; r record; v_pw text;
begin
  if exists (select 1 from auth.users) then
    raise notice 'demo seed skipped: auth.users already has rows (this is not an empty database)';
    return;
  end if;
  if (select name from practices limit 1) is distinct from 'My Practice' then
    raise notice 'demo seed skipped: the practice has already been configured (name is not the default)';
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
    (pa, ua, 'Thandi', 'Nkosi', '1988-03-14', 'patient.a@demo.test', '082 555 0101', 'active', 'Word of mouth'),
    (pb, ub, 'Pieter', 'van der Merwe', '1975-11-02', 'patient.b@demo.test', '082 555 0102', 'active', 'GP referral'),
    (pc, uc, 'Aisha', 'Patel', '1995-07-29', 'patient.c@demo.test', '082 555 0103', 'prospect', 'Website');
  insert into patients(id, first_name, last_name, date_of_birth, email, status, is_minor, emergency_contact) values
    (pm, 'Sipho', 'Dlamini', '2014-05-09', 'guardian@demo.test', 'active', true,
     '{"name":"Lindiwe Dlamini","relationship":"Mother","phone":"082 555 0104"}');
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

  -- ---- a clinical note draft for the attended appointment of patient A (obviously fictional text) ------------------------
  insert into clinical_notes(id, patient_id, appointment_id, template_id, content, author_id)
  select '80000000-0000-4000-8000-000000000001', pa, ap_past_a, t.id,
         '{"subjective":"DEMO TEXT, FICTIONAL. Patient reports a fictional week of mild worry.","objective":"DEMO TEXT. Calm, engaged.","assessment":"DEMO TEXT. No real assessment was made.","plan":"DEMO TEXT. Fictional follow-up in one week."}'::jsonb,
         psy
    from note_templates t where t.name = 'SOAP';

  perform set_config('request.jwt.claims', '', true);
  raise notice 'demo seed loaded: 7 demo accounts (password in the header of this block), 4 patients, 7 appointments, 3 invoices, 1 claim';
end
$demo$;
-- END demo data
