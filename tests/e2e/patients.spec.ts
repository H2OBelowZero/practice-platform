import { test, expect } from "@playwright/test";

// Staff add a patient, then add the same person again and get the duplicate warning. Needs a running app AND a seeded Supabase project
// (Task 17); it cannot run in the local no-Docker setup (R13), so it skips itself when the input below is missing.
//   E2E_STAFF_STATE   path to a Playwright storageState of the psychologist (or admin), already past TOTP (aal2)
const STAFF = process.env.E2E_STAFF_STATE;

test.describe("staff patients", () => {
  test.skip(!STAFF, "set E2E_STAFF_STATE (staff storageState past the authenticator step)");
  test.use({ storageState: STAFF });

  test("create a patient, then see the duplicate warning for the same email", async ({ page }) => {
    const stamp = Date.now();
    const email = `e2e.${stamp}@example.com`;

    await page.goto("/app/patients/new");
    await page.getByLabel("First name").fill("Ethel");
    await page.getByLabel("Last name").fill(`Tester${stamp}`);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Phone number").first().fill("082 555 0199");
    await page.getByRole("button", { name: "Create patient" }).click();

    await page.waitForURL(/\/app\/patients\/[0-9a-f-]{36}\?tab=profile&notice=created/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`Ethel Tester${stamp}`);
    await expect(page.getByText("The patient has been added.")).toBeVisible();
    await expect(page.getByLabel("Phone number")).toHaveValue("+27825550199"); // stored in international form

    // the same email again: warned, not created, until "Create anyway" is ticked
    await page.goto("/app/patients/new");
    await page.getByLabel("First name").fill("Someone");
    await page.getByLabel("Last name").fill("Else");
    await page.getByLabel("Email address").fill(email.toUpperCase());
    await page.getByRole("button", { name: "Create patient" }).click();

    const warning = page.locator("#duplicates");
    await expect(warning.getByText("This patient may already exist")).toBeVisible();
    await expect(warning.getByRole("link", { name: new RegExp(`Ethel Tester${stamp}`) })).toBeVisible();
    await expect(warning).toContainText("same email address");
    expect(page.url()).toContain("/app/patients/new"); // nothing was created
    await expect(page.getByLabel("First name")).toHaveValue("Someone"); // the form kept what was typed
    await expect(page.getByLabel("Create anyway")).not.toBeChecked();

    // search finds the first one by email
    await page.goto(`/app/patients?q=${encodeURIComponent(`e2e.${stamp}`)}`);
    await expect(page.getByRole("link", { name: `Ethel Tester${stamp}` }).first()).toBeVisible();
  });
});
