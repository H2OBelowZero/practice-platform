export type Role = "psychologist" | "admin" | "bookkeeper" | "patient" | "guardian" | "associate";
const STAFF: Role[] = ["psychologist", "admin", "bookkeeper", "associate"];
export const isStaffRole = (r: Role) => STAFF.includes(r);
export const needsMfa = isStaffRole;
export const homeFor = (r: Role) => (isStaffRole(r) ? "/app" : "/portal");
