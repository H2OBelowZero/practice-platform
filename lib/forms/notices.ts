// Success messages shown after a redirect (?notice=code) on the portal documents and privacy pages. Only codes in this map are rendered.
export const FORM_NOTICE_TEXT = {
  submitted: "Thank you. Your form has been submitted and the practice can now see it.",
  saved: "Your answers are saved. You can pick up where you left off at any time.",
  withdrawn: "Your consent has been withdrawn and the practice has been told.",
} as const;
export type FormNoticeCode = keyof typeof FORM_NOTICE_TEXT;
export const formNotice = (code: string | undefined): string | undefined =>
  code !== undefined && Object.hasOwn(FORM_NOTICE_TEXT, code) ? FORM_NOTICE_TEXT[code as FormNoticeCode] : undefined;
