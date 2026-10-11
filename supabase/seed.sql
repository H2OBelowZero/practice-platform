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
      "help": "You can withdraw this consent later from the Documents page of your account."
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
