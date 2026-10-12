// Success messages shown after a redirect (?notice=code). Only codes in this map are ever rendered.
export const NOTICE_TEXT = {
  created: "The draft invoice has been created. Check it, then issue it.",
  saved: "The draft has been saved.",
  issued: "The invoice has been issued.",
  voided: "The invoice has been voided.",
  payment: "The payment has been recorded.",
  credit: "The credit note has been added.",
  exists: "This appointment already has an invoice, so here it is.",
} as const;
export type BillingNoticeCode = keyof typeof NOTICE_TEXT;
export const billingNotice = (code: string | undefined): string | undefined => (code !== undefined && Object.hasOwn(NOTICE_TEXT, code) ? NOTICE_TEXT[code as BillingNoticeCode] : undefined);
