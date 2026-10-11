/** Statuses a patient or staff member can still cancel or move (the cancel/reschedule functions accept exactly these). */
export const ACTIVE_STATUSES = ["requested", "tentative", "confirmed"];
export const isActiveStatus = (status: string) => ACTIVE_STATUSES.includes(status);

/** Can the portal offer Cancel/Reschedule? The database stays the authority; this only decides whether to show the buttons. */
export function portalMayChange(a: { status: string; startsAt: Date }, now: Date): boolean {
  return isActiveStatus(a.status) && a.startsAt.getTime() > now.getTime();
}

/** A guardian may book/cancel/reschedule only inside the guardianship dates and with permissions.book (same test as assert_patient_access). */
export function guardianMayBook(g: { permissions: unknown; valid_from: string; valid_to: string | null }, today: string): boolean {
  const book = (g.permissions as { book?: unknown } | null)?.book;
  return (book === true || book === "true") && g.valid_from <= today && (g.valid_to === null || g.valid_to >= today);
}

/** The last instant a cancellation is free of charge, given the policy window. */
export const freeCancelUntil = (startsAt: Date, windowHours: number): Date => new Date(startsAt.getTime() - windowHours * 3600_000);

/** Same test as reschedule_appointment (0010): a patient cannot move an appointment that starts inside the cancellation window. */
export const insideCancellationWindow = (startsAt: Date, now: Date, windowHours: number): boolean =>
  startsAt.getTime() - now.getTime() < windowHours * 3600_000;
