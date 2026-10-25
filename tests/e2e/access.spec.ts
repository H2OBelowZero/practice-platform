import { test, expect, type Browser } from "@playwright/test";
import { e2eReady, ROLES, SEED, SKIP_MESSAGE, type RoleName } from "./helpers/roles";
import { setGuardianPay } from "./helpers/db";
import { pageFor } from "./helpers/ui";
import { apiAnon, apiAs, visibleRows } from "./helpers/api";

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
// (row-level security filters) or a permission error, and the money / booking functions must refuse a caller who does not own the record.
test.describe("direct API requests (anon key + a user's own token)", () => {
  test.skip(!e2eReady(), SKIP_MESSAGE());
  const B = SEED.patient.b;
  const none = (res: { data: unknown; error: { message: string } | null }, what: string) => expect(visibleRows(res), what).toHaveLength(0);

  test("patient A cannot read patient B's rows in any patient-data table", async () => {
    const a = await apiAs("patientA");
    none(await a.from("patients").select("*").eq("id", B), "patients");
    none(await a.from("appointments").select("*").eq("patient_id", B), "appointments");
    none(await a.from("invoices").select("*").eq("patient_id", B), "invoices");
    none(await a.from("invoice_lines").select("*").eq("invoice_id", SEED.invoice.splitClaim), "invoice_lines");
    none(await a.from("payments").select("*").eq("invoice_id", SEED.invoice.splitClaim), "payments");
    none(await a.from("form_submissions").select("*").eq("patient_id", B), "form_submissions");
    none(await a.from("consents").select("*").eq("patient_id", B), "consents");
    none(await a.from("medical_aid_members").select("*").eq("patient_id", B), "medical_aid_members");
    // and nothing of anyone else's turns up when asking for everything
    for (const t of ["patients", "appointments", "invoices", "form_submissions", "consents"] as const) {
      const rows = visibleRows(await a.from(t).select("*").limit(1000)) as { id?: string; patient_id?: string }[];
      for (const r of rows) expect(r.patient_id ?? r.id, t).not.toBe(B);
    }
  });

  test("patient A sees no clinical, claims, audit, task or outbox data at all", async () => {
    const a = await apiAs("patientA");
    for (const t of ["clinical_notes", "note_versions", "note_addenda", "claims", "claim_events", "claim_payments", "claim_summary", "audit_log", "tasks", "notifications_outbox", "retention_policies"])
      none(await a.from(t).select("*").limit(5), t);
  });

  test("patient A cannot book, pay, remit, cancel or audit on someone else's behalf (the functions refuse)", async () => {
    const a = await apiAs("patientA");
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const book = await a.rpc("book_appointment", { p_patient: B, p_type: SEED.sessionType.followUp, p_start: tomorrow });
    expect(book.error?.message ?? "", "book_appointment for B").toMatch(/forbidden/);
    const pay = await a.rpc("record_payment", { p_invoice: SEED.invoice.splitClaim, p_method: "eft", p_amount: 100, p_ref: "E2E-DIRECT", p_by: null });
    expect(pay.error?.message ?? "", "record_payment").toMatch(/forbidden/);
    const remit = await a.rpc("record_scheme_remittance", { p_claim: "f0000000-0000-4000-8000-000000000002", p_amount: 100, p_ref: "E2E-DIRECT" });
    expect(remit.error?.message ?? "", "record_scheme_remittance").toMatch(/forbidden/);
    const cancel = await a.rpc("cancel_appointment", { p_appt: SEED.appointment.requestC, p_reason: "direct API attempt", p_charge_fee: false });
    expect(cancel.error?.message ?? "", "cancel_appointment for C").toMatch(/forbidden/);
    const audit = await a.rpc("audit_append", { p_actor: null, p_role: "patient", p_action: "forged", p_entity: null, p_entity_id: null, p_detail: null });
    expect(audit.error, "audit_append").not.toBeNull();
    const direct = await a.from("audit_log").insert({ action: "forged" });
    expect(direct.error, "insert into audit_log").not.toBeNull();
    // writes to another person's rows change nothing
    const upd = await a.from("patients").update({ first_name: "Hacked" }).eq("id", B).select();
    expect(visibleRows(upd)).toHaveLength(0);
    const del = await a.from("appointments").delete().eq("patient_id", B).select();
    expect(visibleRows(del)).toHaveLength(0);
  });

  test("patient B's own data is still there for B (the zero rows above are isolation, not an empty database)", async () => {
    const b = await apiAs("patientB");
    expect(visibleRows(await b.from("invoices").select("id").eq("id", SEED.invoice.splitClaim))).toHaveLength(1);
    expect(visibleRows(await b.from("patients").select("id").eq("id", B))).toHaveLength(1);
  });

  test("the admin reads no clinical notes, versions or addenda", async () => {
    const adm = await apiAs("admin");
    for (const t of ["clinical_notes", "note_versions", "note_addenda"]) none(await adm.from(t).select("*").limit(5), t);
    none(await adm.from("tasks").select("*").like("source", "risk_flag:%"), "risk tasks");
    // the psychologist does read them (so the zero above is the role)
    const psy = await apiAs("psychologist");
    expect(visibleRows(await psy.from("clinical_notes").select("id").eq("id", SEED.note))).toHaveLength(1);
  });

  test("the bookkeeper reads no clinical data, no patients, no diagnosis codes, and cannot record payments", async () => {
    const bk = await apiAs("bookkeeper");
    for (const t of ["clinical_notes", "note_versions", "note_addenda", "patients", "form_submissions", "consents", "medical_aid_members", "claims", "audit_log", "tasks"])
      none(await bk.from(t).select("*").limit(5), t);
    none(await bk.from("claims").select("icd10_codes").limit(5), "icd10_codes");
    expect(visibleRows(await bk.from("invoice_balances").select("id").limit(1)).length, "the bookkeeper does read invoice balances").toBeGreaterThan(0);
    const write = await bk.rpc("record_payment", { p_invoice: SEED.invoice.splitClaim, p_method: "eft", p_amount: 100, p_ref: "E2E-DIRECT", p_by: null });
    expect(write.error?.message ?? "").toMatch(/forbidden/);
  });

  test("an anonymous caller (anon key, no sign-in) reads nothing", async () => {
    const anon = apiAnon();
    for (const t of ["patients", "appointments", "invoices", "payments", "clinical_notes", "form_submissions", "consents", "audit_log", "tasks"])
      none(await anon.from(t).select("*").limit(5), t);
    const pay = await anon.rpc("record_payment", { p_invoice: SEED.invoice.splitClaim, p_method: "payfast", p_amount: 100, p_ref: "PF-1", p_by: null });
    expect(pay.error, "record_payment as anon").not.toBeNull();
  });
});
