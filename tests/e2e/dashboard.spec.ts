import { test, expect } from "@playwright/test";

// Staff dashboard and audit viewer. Needs a running app AND the seeded staging project (Task 17); it cannot run in the local no-Docker setup (R13),
// so it skips itself when the inputs below are missing.
//   E2E_STAFF_STATE        storageState of the psychologist, already past TOTP (aal2)
//   E2E_ADMIN_STATE        storageState of the admin (optional)
//   E2E_BOOKKEEPER_STATE   storageState of the bookkeeper (optional)
const STAFF = process.env.E2E_STAFF_STATE, ADMIN = process.env.E2E_ADMIN_STATE, BOOKKEEPER = process.env.E2E_BOOKKEEPER_STATE;

test.describe("psychologist dashboard", () => {
  test.skip(!STAFF, "set E2E_STAFF_STATE (seeded staging project)");
  test.use({ storageState: STAFF });

  test("greets, shows the tiles and sections, and every tile leads somewhere", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Good (morning|afternoon|evening)/);
    for (const label of ["Today's sessions", "Awaiting action", "Outstanding invoices", "Notes to complete", "Unreconciled PayFast payments", "Claims needing attention"])
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    for (const h of ["Today's schedule", "Booking requests", "New patient enquiries", "Coming up in the next 7 days", "Open tasks", "Shortcuts"])
      await expect(page.getByRole("heading", { name: h })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Payments received in / })).toBeVisible();

    await page.getByRole("link", { name: /Outstanding invoices/ }).click();
    await expect(page).toHaveURL(/\/app\/billing$/);
    await page.goBack();
    await page.getByRole("link", { name: "Open calendar" }).first().click();
    await expect(page).toHaveURL(/\/app\/calendar/);
  });

  test("shortcuts open their pages", async ({ page }) => {
    await page.goto("/app");
    await page.getByRole("link", { name: "New patient" }).click();
    await expect(page).toHaveURL(/\/app\/patients\/new/);
  });

  test("no raw errors or stack traces on the page", async ({ page }) => {
    await page.goto("/app");
    await expect(page.locator("body")).not.toContainText(/Error:|stack|undefined|NaN|\[object Object\]/);
  });
});

test.describe("other roles", () => {
  test("the admin sees the operational tiles but no notes tile", async ({ browser }) => {
    test.skip(!ADMIN, "set E2E_ADMIN_STATE");
    const ctx = await browser.newContext({ storageState: ADMIN });
    const page = await ctx.newPage();
    await page.goto("/app");
    await expect(page.getByText("Outstanding invoices", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Notes to complete")).toHaveCount(0);
    await ctx.close();
  });

  test("the bookkeeper is sent to billing", async ({ browser }) => {
    test.skip(!BOOKKEEPER, "set E2E_BOOKKEEPER_STATE");
    const ctx = await browser.newContext({ storageState: BOOKKEEPER });
    const page = await ctx.newPage();
    await page.goto("/app");
    await expect(page).toHaveURL(/\/app\/billing/);
    await ctx.close();
  });
});

test.describe("audit viewer", () => {
  test("psychologist: filter, page and download a CSV; the download is itself recorded", async ({ browser }) => {
    test.skip(!STAFF, "set E2E_STAFF_STATE");
    const ctx = await browser.newContext({ storageState: STAFF });
    const page = await ctx.newPage();
    await page.goto("/app/audit");
    await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
    await page.getByLabel("Action").selectOption("patient");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/prefix=patient/);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download as CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);

    await page.goto("/app/audit?prefix=export");
    await expect(page.getByText("export.audit").first()).toBeVisible();
    await ctx.close();
  });

  test("the admin and the bookkeeper get a 404 for the viewer and the export", async ({ browser }) => {
    test.skip(!ADMIN && !BOOKKEEPER, "set E2E_ADMIN_STATE or E2E_BOOKKEEPER_STATE");
    for (const state of [ADMIN, BOOKKEEPER]) {
      if (!state) continue;
      const ctx = await browser.newContext({ storageState: state });
      const page = await ctx.newPage();
      expect((await page.goto("/app/audit"))?.status()).toBe(404);
      expect((await page.goto("/app/audit/export"))?.status()).toBe(404);
      await ctx.close();
    }
  });
});
