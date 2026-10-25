import { test, expect, type Browser } from "@playwright/test";
import { e2eReady, ROLES, SEED, SKIP_MESSAGE, type RoleName } from "./helpers/roles";
import { setGuardianPay } from "./helpers/db";
import { pageFor } from "./helpers/ui";

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
