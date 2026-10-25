import { chromium, type FullConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { AUTH_DIR, e2eReady, ROLES, SEED, SKIP_MESSAGE, type RoleName } from "./helpers/roles";
import { signInAs } from "./helpers/ui";
import { attendedAppointment, bookSoon, issuedInvoice, must, paymentsOf, svc } from "./helpers/db";
import { raiseUnreconciled } from "./helpers/itn";

/**
 * Runs once before the suite. Without E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY / E2E_SUPABASE_SERVICE_KEY it does nothing (every spec then skips itself),
 * unless E2E_REQUIRE=1, which makes the run FAIL instead (for CI and staging gates, where a silent skip would look like a pass).
 *  0. Refuses to run unless the target project is the demo project (practice name "Demo Practice"): a safety stop against pointing the suite at production.
 *  1. Signs every seeded role in through the real /login (and /mfa for staff: enrols the authenticator the first time and keeps the secret in
 *     tests/e2e/.auth/totp-<role>.json) and stores a storageState per role in tests/e2e/.auth/<role>.json (gitignored).
 *  2. Prepares the few rows the older task-by-task specs expect (an appointment inside the cancellation window, an attended appointment
 *     with no invoice, an open late-fee task, split invoices without claims, a medical aid member) and exports their ids as the E2E_*
 *     variables those specs read. Everything else those specs need is in the seed (fixed ids, tests/e2e/helpers/roles.ts).
 */
export default async function globalSetup(config: FullConfig) {
  if (!e2eReady()) {
    if (process.env.E2E_REQUIRE === "1") throw new Error(`E2E_REQUIRE=1 but the end-to-end environment is incomplete. ${SKIP_MESSAGE()}`);
    console.warn(SKIP_MESSAGE());
    return;
  }
  const practice = must(await svc().from("practices").select("name").limit(1).single(), "read practice") as { name: string };
  if (practice.name !== "Demo Practice") {
    throw new Error(`global setup refused: the practice at E2E_SUPABASE_URL is named "${practice.name}", not "Demo Practice". The e2e suite signs in with public demo passwords and writes test rows: run it only against a throwaway project loaded with supabase/seed-demo.sql, never production.`);
  }
  mkdirSync(AUTH_DIR, { recursive: true });
  const baseURL = String(config.projects[0]?.use?.baseURL ?? process.env.E2E_BASE_URL ?? "http://localhost:3000");

  // 1. sign-ins
  const browser = await chromium.launch();
  try {
    for (const name of Object.keys(ROLES) as RoleName[]) {
      const ctx = await browser.newContext({ baseURL });
      const page = await ctx.newPage();
      try { await signInAs(page, name); }
      catch (e) { throw new Error(`global setup: signing in as ${ROLES[name].email} failed (is the app at ${baseURL} running and the project seeded?): ${(e as Error).message}`); }
      await ctx.storageState({ path: ROLES[name].state });
      await ctx.close();
    }
  } finally { await browser.close(); }

  // 2. rows for the older specs; a failure only costs those specs (they skip when an id is missing)
  const env = process.env;
  const set = (k: string, v: string | undefined) => { if (v) env[k] = v; };
  set("E2E_PASSWORD", env.E2E_PASSWORD || "Demo-Passw0rd-2026");
  set("E2E_STAFF_STATE", ROLES.psychologist.state); set("E2E_ADMIN_STATE", ROLES.admin.state); set("E2E_BOOKKEEPER_STATE", ROLES.bookkeeper.state);
  set("E2E_PATIENT_STATE", ROLES.patientA.state); set("E2E_GUARDIAN_STATE", ROLES.guardian.state); set("E2E_CHILD_NAME", "Sipho");
  set("E2E_PATIENT_A_EMAIL", ROLES.patientA.email); set("E2E_PATIENT_B_EMAIL", ROLES.patientB.email);
  set("E2E_PATIENT_EMAIL", ROLES.patientC.email); set("E2E_PATIENT_RECORD_ID", SEED.patient.c); // forms.spec / notes.spec work on patient C
  set("E2E_MA_PATIENT_ID", SEED.patient.a); set("E2E_SELF_INVOICE_ID", SEED.invoice.selfPartPaid); set("E2E_PAID_INVOICE_ID", SEED.invoice.selfPartPaid);
  set("E2E_OTHER_INVOICE_ID", SEED.invoice.minor); set("E2E_BASE_HAS_DATA", "1"); set("E2E_TASKS_UI", "1");
  try {
    set("E2E_PAID_PAYMENT_ID", (await paymentsOf(SEED.invoice.selfPartPaid))[0]?.id);
    set("E2E_LATE_APPT_ID", await bookSoon(SEED.patient.a, SEED.sessionType.followUp, 150));
    set("E2E_ATTENDED_APPT_ID", await attendedAppointment(SEED.patient.c, SEED.sessionType.followUp));
    const feeAppt = await bookSoon(SEED.patient.b, SEED.sessionType.followUp, 320);
    must(await svc().rpc("cancel_appointment", { p_appt: feeAppt, p_reason: "E2E setup: late cancellation", p_charge_fee: true }), "cancel_appointment (fee)");
    const tasks = must(await svc().from("tasks").select("id").eq("source", "late_cancel_fee").eq("appointment_id", feeAppt).eq("status", "open"), "fee task");
    set("E2E_FEE_TASK_ID", tasks?.[0]?.id);
    const members = must(await svc().from("medical_aid_members").select("id").eq("patient_id", SEED.patient.a), "members");
    if (!members?.length) must(await svc().from("medical_aid_members").insert({ patient_id: SEED.patient.a, scheme: "Demo Medical Scheme", plan: "Demo Plan", member_number: "DEMO-A-0001", dependant_code: "00", valid_from: "2024-01-01" }).select("id"), "member");
    set("E2E_SPLIT_INVOICE_ID", await issuedInvoice({ patientId: SEED.patient.a, payer: "split", totalCents: 95000, schemeCents: 76000 }));
    set("E2E_MA_INVOICE_ID", await issuedInvoice({ patientId: SEED.patient.a, payer: "medical_aid", totalCents: 95000, schemeCents: 95000 }));
    // an unmatched PayFast payment for tasks.spec, raised exactly as the ITN route does (service client, same arguments), so that spec does not depend on workflow C
    const source = await raiseUnreconciled(SEED.invoice.selfPartPaid, 55000, 55000, "amount_mismatch");
    set("E2E_UNRECONCILED_TASK_ID", (must(await svc().from("tasks").select("id").eq("source", source).single(), "unreconciled task") as { id: string }).id);
  } catch (e) {
    console.warn(`global setup: could not prepare every row for the older specs (${(e as Error).message}); the specs that need them will skip.`);
  }
}
