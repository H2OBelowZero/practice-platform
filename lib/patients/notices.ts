// Success messages shown after a redirect (?notice=code). Only codes in this map are ever rendered.
export const NOTICE_TEXT = {
  created: "The patient has been added.",
  saved: "Changes saved.",
  saved_reinvite: "Changes saved. The email address changed, so the earlier portal invitation no longer applies. Invite the patient again when you are ready.",
  unchanged: "Nothing was changed.",
  archived: "The patient has been archived. Their record is kept.",
  restored: "The patient has been restored.",
  invited: "The invitation has been queued. The patient will get an email with a link to register.",
} as const;
export type PatientNoticeCode = keyof typeof NOTICE_TEXT;
export const patientNotice = (code: string | undefined): string | undefined => (code !== undefined && Object.hasOwn(NOTICE_TEXT, code) ? NOTICE_TEXT[code as PatientNoticeCode] : undefined);
