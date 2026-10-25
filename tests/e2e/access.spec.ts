import { test, expect, type Browser } from "@playwright/test";
import { e2eReady, ROLES, SEED, SKIP_MESSAGE, type RoleName } from "./helpers/roles";
import { setGuardianPay, svc } from "./helpers/db";
import { pageFor } from "./helpers/ui";
import type { SupabaseClient } from "@supabase/supabase-js";
import { apiAnon, apiAs, classify, expectBlocked, visibleRows, type Res } from "./helpers/api";

// Role matrix over the real pages (spec section 4): who gets a 404 (the area is not revealed), who is sent to sign in, and that nobody can
// read another person's record by guessing a URL. Read-only except the guardian block, which switches the guardian's "pay" permission off
// for its duration and back on afterwards. Tests tagged @mobile also run in the 375 x 812 project.
test.describe("access matrix", () => {
  test.skip(!e2eReady(), SKIP_MESSAGE());

  const status = async (browser: Browser, role: RoleName, url: string) => {
    const page = await pageFor(browser, role);
    const res = await page.goto(url);
    const body = await page.locator("body").innerText();
    await page.context().close();
    return { code: res?.status(), body, url: page.url() };
  };

  test("an anonymous visitor is sent to sign in from the workspace and the portal @mobile", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const area of ["/app", "/app/patients", "/portal", "/portal/payments"]) {
      await page.goto(area);
      await expect(page).toHaveURL(/\/login/);
    }
    // an invoice link does not leak its existence to a stranger either
    await page.goto(`/portal/payments/${SEED.invoice.selfPartPaid}`);
    await expect(page).toHaveURL(/\/login/);
    await ctx.close();
  });

  test("the admin gets a 404 for a clinical note and the new-note page, and has no Clinical notes tab @mobile", async ({ browser }) => {
    expect((await status(browser, "admin", `/app/notes/${SEED.note}`)).code).toBe(404);
    expect((await status(browser, "admin", `/app/patients/${SEED.patient.a}/notes/new`)).code).toBe(404);
    const page = await pageFor(browser, "admin");
    await page.goto(`/app/patients/${SEED.patient.a}`);
    await expect(page.getByRole("link", { name: "Clinical notes" })).toHaveCount(0);
    await page.context().close();
  });

  test("the psychologist can open the same note (so the 404 above is the role, not a bad id)", async ({ browser }) => {
    const r = await status(browser, "psychologist", `/app/notes/${SEED.note}`);
    expect(r.code).toBe(200);
    expect(r.body).toContain("DEMO TEXT");
  });

  test("the bookkeeper cannot open patients, claims, tasks or the audit log; billing is readable but has no patient names @mobile", async ({ browser }) => {
    for (const url of ["/app/patients", `/app/patients/${SEED.patient.a}`, "/app/claims", "/app/tasks", "/app/audit", `/app/notes/${SEED.note}`])
      expect((await status(browser, "bookkeeper", url)).code, url).toBe(404);
    const page = await pageFor(browser, "bookkeeper");
    expect((await page.goto("/app/billing"))?.status()).toBe(200);
    await expect(page.getByRole("columnheader", { name: "Patient" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/Nkosi|van der Merwe|Patel|Dlamini|Thandi|Pieter|Aisha|Sipho/); // no seeded patient name anywhere on the page
    expect((await page.goto("/portal"))?.status()).toBe(404);
    await page.context().close();
  });

  test("the admin cannot open the audit log; the psychologist can", async ({ browser }) => {
    expect((await status(browser, "admin", "/app/audit")).code).toBe(404);
    expect((await status(browser, "psychologist", "/app/audit")).code).toBe(200);
  });

  test("a patient cannot open the workspace @mobile", async ({ browser }) => {
    for (const url of ["/app", "/app/patients", "/app/billing", `/app/notes/${SEED.note}`])
      expect((await status(browser, "patientA", url)).code, url).toBe(404);
    expect((await status(browser, "patientA", "/portal")).code).toBe(200);
  });

  test("a patient cannot read another person's invoice or appointment by URL (404, no data)", async ({ browser }) => {
    const page = await pageFor(browser, "patientA");
    for (const id of [SEED.invoice.splitClaim, SEED.invoice.minor]) {
      const res = await page.goto(`/portal/payments/${id}`);
      expect(res?.status(), id).toBe(404);
      await expect(page.locator("body")).not.toContainText(/INV-\d+|R\s\d/);
    }
    expect((await page.goto(`/portal/payments/${SEED.invoice.splitClaim}/receipts/${SEED.invoice.selfPartPaid}`))?.status()).toBe(404);
    expect((await page.goto(`/portal/appointments/${SEED.appointment.requestC}`))?.status()).toBe(404);
    // and their own is there
    expect((await page.goto(`/portal/payments/${SEED.invoice.selfPartPaid}`))?.status()).toBe(200);
    await page.context().close();
  });

  test("the patient list pages show only the patient's own invoices", async ({ browser }) => {
    const page = await pageFor(browser, "patientB");
    await page.goto("/portal/payments");
    await expect(page.locator(`a[href="/portal/payments/${SEED.invoice.splitClaim}"]`).first()).toBeVisible();
    await expect(page.locator(`a[href="/portal/payments/${SEED.invoice.selfPartPaid}"]`)).toHaveCount(0);
    await page.context().close();
  });

  test.describe("a guardian without the pay permission", () => {
    test.beforeAll(async () => { await setGuardianPay(SEED.user.guardian, SEED.patient.minor, false); });
    test.afterAll(async () => { await setGuardianPay(SEED.user.guardian, SEED.patient.minor, true); });

    test("sees no invoices and cannot open the child's invoice; the appointments page still opens @mobile", async ({ browser }) => {
      const page = await pageFor(browser, "guardian");
      await page.goto("/portal/payments");
      await expect(page.locator(`a[href="/portal/payments/${SEED.invoice.minor}"]`)).toHaveCount(0);
      await expect(page.getByText("For Sipho")).toHaveCount(0);
      expect((await page.goto(`/portal/payments/${SEED.invoice.minor}`))?.status()).toBe(404);
      expect((await page.goto("/portal/appointments"))?.status()).toBe(200);
      await page.context().close();
    });
  });

  test("with the pay permission the guardian sees the child's invoice, labelled with the child's first name", async ({ browser }) => {
    const page = await pageFor(browser, "guardian");
    await page.goto("/portal/payments");
    await expect(page.getByText("For Sipho").first()).toBeVisible();
    expect(ROLES.guardian.email).toBe("guardian@demo.test");
    await page.context().close();
  });
});

// ---- direct API requests -------------------------------------------------------------------------------------------------------------------
// The blueprint requires isolation "including through direct API requests". These calls bypass the website completely: PostgREST with the
// public anon key and one user's access token (helpers/api.ts). Every table another person's data could sit in must answer with zero rows
// (row-level security filters) or a permission-denied error, and the money / booking functions must refuse a caller who does not own the record.
//
// Two rules keep these checks from being vacuous:
//  1. every "cannot read" has a POSITIVE CONTROL: the identical query, run with the service key (or as the psychologist where the service role has
//     no access by design), must return at least one of patient B's rows. The seed gives B rows in every one of these tables;
//  2. only an empty result or a permission-denied error counts as blocked. Any other error (undefined table or column, PostgREST error) fails.
type Q = (sb: SupabaseClient) => PromiseLike<Res>;
const B = SEED.patient.b;
const B_ROWS: Record<string, Q> = {
  patients: (sb) => sb.from("patients").select("id").eq("id", B),
  appointments: (sb) => sb.from("appointments").select("id").eq("patient_id", B),
  invoices: (sb) => sb.from("invoices").select("id").eq("patient_id", B),
  invoice_lines: (sb) => sb.from("invoice_lines").select("id").eq("invoice_id", SEED.invoice.splitClaim),
  payments: (sb) => sb.from("payments").select("id").eq("invoice_id", SEED.invoice.medicalAidOnly),
  form_submissions: (sb) => sb.from("form_submissions").select("id").eq("patient_id", B),
  consents: (sb) => sb.from("consents").select("id").eq("patient_id", B),
  medical_aid_members: (sb) => sb.from("medical_aid_members").select("id").eq("id", SEED.member.b),
  clinical_notes: (sb) => sb.from("clinical_notes").select("id").eq("patient_id", B),
  note_versions: (sb) => sb.from("note_versions").select("id").eq("note_id", SEED.noteB),
  note_addenda: (sb) => sb.from("note_addenda").select("id").eq("note_id", SEED.noteB),
  claims: (sb) => sb.from("claims").select("id").eq("member_id", SEED.member.b),
  claim_events: (sb) => sb.from("claim_events").select("id").eq("claim_id", SEED.claim.medicalAid),
  claim_payments: (sb) => sb.from("claim_payments").select("id").eq("claim_id", SEED.claim.medicalAid),
  claim_summary: (sb) => sb.from("claim_summary").select("id").eq("invoice_id", SEED.invoice.medicalAidOnly),
  audit_log: (sb) => sb.from("audit_log").select("id").eq("entity_id", B),
  tasks: (sb) => sb.from("tasks").select("id").eq("patient_id", B),
  risk_tasks: (sb) => sb.from("tasks").select("id").like("source", "risk_flag:%"),
  notifications_outbox: (sb) => sb.from("notifications_outbox").select("id").eq("recipient", "patient.b@demo.test"),
  retention_policies: (sb) => sb.from("retention_policies").select("record_type"),
};
const ALL = Object.keys(B_ROWS);
const PATIENT_TABLES = ["patients", "appointments", "invoices", "invoice_lines", "payments", "form_submissions", "consents", "medical_aid_members"];
/** tables the service role cannot read by design (a view with no service grant) or that are psychologist-only rows */
const AS_PSYCHOLOGIST = new Set(["claim_summary", "risk_tasks"]);

async function control(names: string[]) {
  for (const n of names) {
    const res = await B_ROWS[n](AS_PSYCHOLOGIST.has(n) ? await apiAs("psychologist") : svc());
    expect(classify(res), `positive control for ${n}`).toMatchObject({ kind: "rows" });
    expect((classify(res) as { n: number }).n, `positive control for ${n}`).toBeGreaterThanOrEqual(1);
  }
}
async function blocked(who: string, client: SupabaseClient, names: string[]) {
  for (const n of names) expectBlocked(await B_ROWS[n](client), `${who} reading ${n}`);
}

test.describe("direct API requests (anon key + a user's own token)", () => {
  test.skip(!e2eReady(), SKIP_MESSAGE());

  test("the blocked-check fails on a misspelt table or column, so an error is never mistaken for 'no rows'", async () => {
    const a = await apiAs("patientA");
    const typoTable = await a.from("definitely_not_a_table").select("id");
    expect(() => expectBlocked(typoTable, "misspelt table")).toThrow();
    const typoColumn = await a.from("patients").select("id").eq("no_such_column", 1);
    expect(() => expectBlocked(typoColumn, "misspelt column")).toThrow();
    const own = await a.from("patients").select("id").limit(1);
    expect(() => expectBlocked(own, "own rows are not blocked")).toThrow();
  });

  test("positive controls: every table the checks cover really holds patient B's rows", async () => {
    await control(ALL);
  });

  test("patient A cannot read patient B's rows in any table", async () => {
    await control(ALL);
    const a = await apiAs("patientA");
    await blocked("patient A", a, ALL);
    // and nothing of anyone else's turns up when asking for everything
    for (const t of ["patients", "appointments", "invoices", "form_submissions", "consents"] as const) {
      const rows = visibleRows(await a.from(t).select("*").limit(1000)) as { id?: string; patient_id?: string }[];
      for (const r of rows) expect(r.patient_id ?? r.id, t).not.toBe(B);
    }
  });

  test("patient A cannot book, pay, remit, cancel or audit on someone else's behalf (the functions refuse)", async () => {
    const a = await apiAs("patientA");
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const book = await a.rpc("book_appointment", { p_patient: B, p_type: SEED.sessionType.followUp, p_start: tomorrow });
    expect(book.error?.message ?? "", "book_appointment for B").toMatch(/forbidden/);
    const pay = await a.rpc("record_payment", { p_invoice: SEED.invoice.splitClaim, p_method: "eft", p_amount: 100, p_ref: "E2E-DIRECT", p_by: null });
    expect(pay.error?.message ?? "", "record_payment").toMatch(/forbidden/);
    const remit = await a.rpc("record_scheme_remittance", { p_claim: SEED.claim.medicalAid, p_amount: 100, p_ref: "E2E-DIRECT" });
    expect(remit.error?.message ?? "", "record_scheme_remittance").toMatch(/forbidden/);
    const cancel = await a.rpc("cancel_appointment", { p_appt: SEED.appointment.requestC, p_reason: "direct API attempt", p_charge_fee: false });
    expect(cancel.error?.message ?? "", "cancel_appointment for C").toMatch(/forbidden/);
    const audit = await a.rpc("audit_append", { p_actor: null, p_role: "patient", p_action: "forged", p_entity: null, p_entity_id: null, p_detail: null });
    expect(audit.error?.code ?? audit.error?.message, "audit_append").toMatch(/42501|permission denied/);
    const direct = await a.from("audit_log").insert({ action: "forged" });
    expect(direct.error?.code ?? direct.error?.message, "insert into audit_log").toMatch(/42501|permission denied|row-level security/);
    // writes to another person's rows change nothing (the row exists: control below)
    const upd = await a.from("patients").update({ first_name: "Hacked" }).eq("id", B).select();
    expect(upd.error === null ? visibleRows(upd) : [], "update returns no row").toHaveLength(0);
    const del = await a.from("appointments").delete().eq("patient_id", B).select();
    expect(del.error === null ? visibleRows(del) : [], "delete returns no row").toHaveLength(0);
    const after = await svc().from("patients").select("first_name").eq("id", B).single();
    expect(after.data?.first_name).toBe("Pieter");
    expect(visibleRows(await svc().from("appointments").select("id").eq("patient_id", B)).length, "B's appointments survive").toBeGreaterThanOrEqual(2);
  });

  test("patient B reads B's own rows (the zero rows above are isolation, not an empty database)", async () => {
    const b = await apiAs("patientB");
    for (const n of PATIENT_TABLES) expect(classify(await B_ROWS[n](b)), `B reading own ${n}`).toMatchObject({ kind: "rows" });
    for (const n of PATIENT_TABLES) expect((classify(await B_ROWS[n](b)) as { n: number }).n, n).toBeGreaterThanOrEqual(1);
  });

  test("the admin reads no clinical notes, versions, addenda or risk tasks (control: the psychologist does)", async () => {
    const clinical = ["clinical_notes", "note_versions", "note_addenda", "risk_tasks"];
    await control(clinical);
    await blocked("admin", await apiAs("admin"), clinical);
  });

  test("the bookkeeper reads no clinical, patient or diagnosis data and cannot record payments", async () => {
    const names = ["clinical_notes", "note_versions", "note_addenda", "patients", "form_submissions", "consents", "medical_aid_members", "claims", "claim_events",
      "audit_log", "tasks", "risk_tasks", "notifications_outbox", "retention_policies"];
    await control(names);
    const bk = await apiAs("bookkeeper");
    await blocked("bookkeeper", bk, names);
    const codes = await bk.from("claims").select("icd10_codes").eq("member_id", SEED.member.b);
    expectBlocked(codes, "bookkeeper reading icd10_codes");
    // what the bookkeeper may read is there
    for (const n of ["claim_summary", "claim_payments", "payments"]) expect((classify(await B_ROWS[n](bk)) as { n: number }).n, `bookkeeper reading ${n}`).toBeGreaterThanOrEqual(1);
    expect(visibleRows(await bk.from("invoice_balances").select("id").limit(1)).length).toBeGreaterThan(0);
    const write = await bk.rpc("record_payment", { p_invoice: SEED.invoice.splitClaim, p_method: "eft", p_amount: 100, p_ref: "E2E-DIRECT", p_by: null });
    expect(write.error?.message ?? "").toMatch(/forbidden/);
  });

  test("a staff password without the authenticator code (aal1) reads nothing and the staff functions refuse (two-step is enforced by the database)", async () => {
    const names = ["clinical_notes", "patients", "invoices", "payments", "form_submissions", "consents", "claims", "claim_summary", "audit_log", "tasks"];
    await control(names);
    for (const role of ["psychologist", "admin", "bookkeeper"] as const) {
      const weak = await apiAs(role, { aal: "aal1" });
      await blocked(`${role} (aal1)`, weak, names);
      const pay = await weak.rpc("record_payment", { p_invoice: SEED.invoice.splitClaim, p_method: "eft", p_amount: 100, p_ref: "E2E-AAL1", p_by: null });
      expect(pay.error?.message ?? "", `${role} aal1 record_payment`).toMatch(/forbidden/);
      const today = new Date().toISOString().slice(0, 10);
      const rep = await weak.rpc("report_income_by_month", { p_from: today, p_to: today });
      expect(rep.error?.message ?? "", `${role} aal1 report`).toMatch(/forbidden/);
      // its own profile stays readable, so the app can send the person to /mfa
      const me = visibleRows(await weak.from("profiles").select("role")) as { role: string }[];
      expect(me.map((r) => r.role)).toEqual([role]);
    }
  });

  test("an anonymous caller (anon key, no sign-in) reads nothing", async () => {
    const names = ["patients", "appointments", "invoices", "payments", "clinical_notes", "form_submissions", "consents", "audit_log", "tasks"];
    await control(names);
    await blocked("anonymous", apiAnon(), names);
    const pay = await apiAnon().rpc("record_payment", { p_invoice: SEED.invoice.splitClaim, p_method: "payfast", p_amount: 100, p_ref: "PF-1", p_by: null });
    expect(pay.error?.code ?? pay.error?.message, "record_payment as anon").toMatch(/42501|permission denied/);
  });
});
