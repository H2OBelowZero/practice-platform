/** One appointment as the calendar shows it (names only; no clinical detail ever reaches these views). */
export type CalAppt = {
  id: string; starts_at: string; ends_at: string; status: string;
  patientId: string | null; patientName: string; typeName: string;
};
