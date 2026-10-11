/** Whole years between a YYYY-MM-DD date of birth and a YYYY-MM-DD "today". Null when either is missing. */
export function ageOn(dob: string | null | undefined, today: string): number | null {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  if (![y, m, d, ty, tm, td].every(Number.isFinite)) return null;
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** A patient is treated as a minor when flagged so, or when the date of birth says they are under 18. */
export const isMinor = (p: { is_minor: boolean; date_of_birth: string | null }, today: string): boolean => {
  const age = ageOn(p.date_of_birth, today);
  return p.is_minor || (age !== null && age < 18);
};

/** "P0012" for patient number 12. */
export const patientNo = (n: number): string => `P${String(n).padStart(4, "0")}`;
