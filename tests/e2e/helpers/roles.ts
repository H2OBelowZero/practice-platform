import { join } from "node:path";

// The seeded demo accounts (supabase/seed-demo.sql) and the fixed ids the seed gives its rows.
export const AUTH_DIR = join(__dirname, "..", ".auth");
export const PASSWORD = process.env.E2E_PASSWORD || "Demo-Passw0rd-2026";

export type RoleName = "psychologist" | "admin" | "bookkeeper" | "patientA" | "patientB" | "patientC" | "guardian";
export type RoleInfo = { email: string; staff: boolean; home: RegExp; state: string; totpFile: string };

const role = (email: string, staff: boolean, name: RoleName): RoleInfo => ({
  email, staff, home: staff ? /\/app/ : /\/portal/,
  state: join(AUTH_DIR, `${name}.json`), totpFile: join(AUTH_DIR, `totp-${name}.json`),
});

export const ROLES: Record<RoleName, RoleInfo> = {
  psychologist: role("psychologist@demo.test", true, "psychologist"),
  admin: role("admin@demo.test", true, "admin"),
  bookkeeper: role("bookkeeper@demo.test", true, "bookkeeper"),
  patientA: role("patient.a@demo.test", false, "patientA"),
  patientB: role("patient.b@demo.test", false, "patientB"),
  patientC: role("patient.c@demo.test", false, "patientC"),
  guardian: role("guardian@demo.test", false, "guardian"),
};

/** Fixed ids from the seed. */
export const SEED = {
  patient: { a: "b0000000-0000-4000-8000-000000000011", b: "b0000000-0000-4000-8000-000000000012", c: "b0000000-0000-4000-8000-000000000013", minor: "b0000000-0000-4000-8000-000000000014" },
  user: { psychologist: "a0000000-0000-4000-8000-000000000001", guardian: "a0000000-0000-4000-8000-000000000021" },
  sessionType: { initial: "d0000000-0000-4000-8000-000000000001", followUp: "d0000000-0000-4000-8000-000000000002", video: "d0000000-0000-4000-8000-000000000003" },
  invoice: { selfPartPaid: "c0000000-0000-4000-8000-000000000001", splitClaim: "c0000000-0000-4000-8000-000000000002", minor: "c0000000-0000-4000-8000-000000000003", medicalAidOnly: "c0000000-0000-4000-8000-000000000004" },
  appointment: { pastA: "e0000000-0000-4000-8000-000000000001", futureA: "e0000000-0000-4000-8000-000000000004", requestC: "e0000000-0000-4000-8000-000000000005" },
  note: "80000000-0000-4000-8000-000000000001",
} as const;

/** Name of the follow-up session type as the booking page shows it (case-sensitive: "Video follow-up" must not match). */
export const FOLLOW_UP = /Follow-up/;

/** The environment the suite needs. */
export const E2E_VARS = ["E2E_SUPABASE_URL", "E2E_SUPABASE_ANON_KEY", "E2E_SUPABASE_SERVICE_KEY"] as const;
export const missingE2E = () => E2E_VARS.filter((v) => !process.env[v]);
export const e2eReady = () => missingE2E().length === 0;
export const SKIP_MESSAGE = () =>
  `E2E environment not set (missing ${missingE2E().join(", ")}). Needs a running app plus a seeded Supabase project: see README "Running the end-to-end tests".`;
