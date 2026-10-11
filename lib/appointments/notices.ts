// Success messages shown after a redirect (?notice=code). Only codes in this map are ever rendered.
export const NOTICE_TEXT = {
  cancelled: "Your appointment has been cancelled.",
  cancelled_late: "Your appointment has been cancelled. Because it was inside the cancellation window, the practice will be in touch about the late cancellation fee.",
  rescheduled: "Your appointment has been moved to the new time. We will email you a short confirmation.",
  created: "The appointment has been booked.",
  confirmed: "The appointment is confirmed and the patient has been told.",
  declined: "The request has been declined and the patient has been told.",
  attended: "Marked as attended.",
  no_show: "Marked as a no-show.",
  cancelled_staff: "The appointment has been cancelled and the patient has been told.",
  rescheduled_staff: "The appointment has been moved and the patient has been told.",
} as const;
export type NoticeCode = keyof typeof NOTICE_TEXT;
export const noticeText = (code: string | undefined): string | undefined => (code !== undefined && Object.hasOwn(NOTICE_TEXT, code) ? NOTICE_TEXT[code as NoticeCode] : undefined);
