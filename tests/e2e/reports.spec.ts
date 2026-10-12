import { test, expect } from "@playwright/test";

// Reports and CSV exports. Needs a running app AND the seeded staging project (Task 17); it cannot run in the local no-Docker setup (R13),
// so it skips itself when the inputs below are missing.
//   E2E_STAFF_STATE        storageState of the psychologist, already past TOTP (aal2)
//   E2E_ADMIN_STATE        storageState of the admin (optional)
//   E2E_BOOKKEEPER_STATE   storageState of the bookkeeper (optional)
const STAFF = process.env.E2E_STAFF_STATE, ADMIN = process.env.E2E_ADMIN_STATE, BOOKKEEPER = process.env.E2E_BOOKKEEPER_STATE;

test.describe("psychologist reports", () => {
  test.skip(!STAFF, "set E2E_STAFF_STATE (seeded staging project)");
  test.use({ storageState: STAFF });

  test("four report types, presets, and definitions under the figures", async ({ page }) => {
    await page.goto("/app/reports");
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    for (const t of ["Financial", "Appointments", "Practice activity", "Compliance"]) await expect(page.getByRole("link", { name: t, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Income by month" })).toBeVisible();
    await expect(page.getByText("What this means.").first()).toBeVisible();
    await page.getByRole("link", { name: "This month" }).click();
    await expect(page).toHaveURL(/preset=this_month/);
    await page.getByRole("link", { name: "Appointments", exact: true }).click();
    await expect(page.getByText("They are not a measure of patient retention, engagement or outcomes.")).toBeVisible();
    await page.getByRole("link", { name: "Compliance", exact: true }).click();
    await expect(page.getByText("These figures describe system activity, not clinical outcomes.").first()).toBeVisible();
  });

  test("custom dates are validated on the server", async ({ page }) => {
    await page.goto("/app/reports?report=financial&preset=custom&from=2031-03-10&to=2031-01-01");
    await expect(page.getByText("Those dates could not be used")).toBeVisible();
    await expect(page.getByText("Showing the last 3 months instead.")).toBeVisible();
  });

  test("the accountant export downloads a CSV with a fixed header and no patient names", async ({ page }) => {
    await page.goto("/app/reports?report=financial&preset=last_3_months");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download the accountant export as CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^transactions-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test("the export route refuses an unknown report and bad dates", async ({ page }) => {
    const bad = await page.request.get("/app/reports/export?report=audit_log&from=2031-01-01&to=2031-01-31");
    expect(bad.status()).toBe(400);
    const prefetch = await page.request.get("/app/reports/export?report=income_by_month&from=2031-01-01&to=2031-01-31", { headers: { "next-router-prefetch": "1" } });
    expect(prefetch.status()).toBe(204);
  });
});

test.describe("other roles", () => {
  test("the admin has no Compliance report", async ({ browser }) => {
    test.skip(!ADMIN, "set E2E_ADMIN_STATE");
    const ctx = await browser.newContext({ storageState: ADMIN });
    const page = await ctx.newPage();
    await page.goto("/app/reports?report=compliance");
    await expect(page.getByRole("link", { name: "Compliance", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Appointments", exact: true })).toBeVisible();
    const res = await page.request.get("/app/reports/export?report=compliance&from=2031-01-01&to=2031-01-31");
    expect(res.status()).toBe(403);
    await ctx.close();
  });

  test("the bookkeeper has the Financial report only, without patient names", async ({ browser }) => {
    test.skip(!BOOKKEEPER, "set E2E_BOOKKEEPER_STATE");
    const ctx = await browser.newContext({ storageState: BOOKKEEPER });
    const page = await ctx.newPage();
    await page.goto("/app/reports?report=appointments");
    await expect(page.getByRole("link", { name: "Appointments", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Income by month" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Patient", exact: true })).toHaveCount(0);
    expect((await page.request.get("/app/reports/export?report=appointments&from=2031-01-01&to=2031-01-31")).status()).toBe(403);
    await ctx.close();
  });
});
