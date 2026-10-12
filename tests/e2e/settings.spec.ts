import { test, expect } from "@playwright/test";

// Settings: practice details, payment instructions (with the review step), session types, working hours, blocked time, retention, and the admin's read-only view.
// Needs a running app AND the seeded staging project (Task 17); it cannot run in the local no-Docker setup (R13), so it skips itself when the inputs below are missing.
//   E2E_STAFF_STATE        storageState of the psychologist, already past TOTP (aal2)
//   E2E_ADMIN_STATE        storageState of the admin (optional)
//   E2E_BOOKKEEPER_STATE   storageState of the bookkeeper (optional)
const STAFF = process.env.E2E_STAFF_STATE, ADMIN = process.env.E2E_ADMIN_STATE, BOOKKEEPER = process.env.E2E_BOOKKEEPER_STATE;

test.describe("settings as the psychologist", () => {
  test.skip(!STAFF, "set E2E_STAFF_STATE (seeded staging project)");
  test.use({ storageState: STAFF });

  test("practice details: a bad VAT rate is refused with a message, a good save is confirmed, and the crisis preview follows the text", async ({ page }) => {
    await page.goto("/app/settings");
    await page.getByLabel("VAT rate (%)").fill("150");
    await page.getByRole("button", { name: "Save practice details" }).click();
    await expect(page.getByText("The VAT rate must be between 0 and 100.").first()).toBeVisible();
    await page.getByLabel("VAT rate (%)").fill("15");
    await page.getByLabel("Crisis and escalation text").fill("If you are in crisis call SADAG 0800 567 567. E2E preview.");
    await expect(page.getByLabel("In an emergency")).toContainText("E2E preview.");
    await page.getByRole("button", { name: "Save practice details" }).click();
    await page.waitForURL(/section=practice&notice=practice_saved/);
    await expect(page.getByText("The practice details are saved.")).toBeVisible();
  });

  test("payment instructions: the warning, the tick, the review step, then the audit note", async ({ page }) => {
    await page.goto("/app/settings?section=payment");
    await expect(page.getByText("Criminals change bank details to redirect payments")).toBeVisible();
    await page.getByLabel(/Payment instructions/).fill("Account holder: E2E Practice\nBank: Example Bank\nAccount: 0000000000");
    await page.getByRole("button", { name: "Review and save" }).click();
    await expect(page.getByText("Tick the box to confirm you have checked the bank details.").first()).toBeVisible(); // not ticked yet: refused after the review step
    await page.getByLabel(/I have checked every character/).check();
    await page.getByRole("button", { name: "Review and save" }).click();
    await expect(page.getByTestId("payment-preview")).toContainText("Account: 0000000000");
    await page.getByRole("button", { name: "Yes, these details are correct" }).click();
    await page.waitForURL(/section=payment&notice=payment_saved/);
    await expect(page.getByText("This change was recorded in the audit log.")).toBeVisible();

    // the audit log shows the change by field name, never the text
    await page.goto("/app/audit?action=settings.payment_instructions");
    await expect(page.getByText("payment_instructions").first()).toBeVisible();
    await expect(page.getByText("Account: 0000000000")).toHaveCount(0);
  });

  test("session types: add one, switch it off, and it leaves the booking page", async ({ page }) => {
    const name = `E2E session ${Date.now()}`;
    await page.goto("/app/settings?section=session-types");
    await page.getByText("Add a session type").click();
    await page.locator("#new-type-name").fill(name);
    await page.locator("#new-type-fee").fill("123,45");
    await page.getByRole("button", { name: "Add session type" }).click();
    await page.waitForURL(/notice=type_added/);
    const row = page.getByRole("listitem").filter({ hasText: name });
    await expect(row).toContainText("R 123,45");
    await expect(row.getByText("Active")).toBeVisible();

    await page.goto("/book");
    await expect(page.getByText(name)).toBeVisible();

    await page.goto("/app/settings?section=session-types");
    await row.getByText("Edit").click();
    await row.getByRole("switch", { name: "Active" }).uncheck();
    await row.getByRole("button", { name: "Save session type" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: name }).getByText("Inactive: not bookable")).toBeVisible();
    await page.goto("/book");
    await expect(page.getByText(name)).toHaveCount(0);
  });

  test("working hours: two windows on Tuesday, an overlap is refused, copy Monday, and the future-bookings note", async ({ page }) => {
    await page.goto("/app/settings?section=hours");
    await expect(page.getByText("future bookings only").first()).toBeVisible();
    const tuesday = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Tuesday" }) });
    await tuesday.getByRole("button", { name: "Add a window" }).click();
    await tuesday.getByRole("button", { name: "Add a window" }).click();
    const froms = tuesday.getByLabel("From"), untils = tuesday.getByLabel("Until");
    await froms.nth(0).fill("08:00"); await untils.nth(0).fill("12:00");
    await froms.nth(1).fill("11:00"); await untils.nth(1).fill("13:00");
    await tuesday.getByRole("button", { name: "Save Tuesday" }).click();
    await expect(page.getByText("Two windows overlap.").first()).toBeVisible();
    await froms.nth(1).fill("13:00"); await untils.nth(1).fill("17:00");
    await tuesday.getByRole("button", { name: "Save Tuesday" }).click();
    await page.waitForURL(/notice=hours_saved/);
    await expect(page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Tuesday" }) }).getByLabel("From")).toHaveCount(2);
    await page.getByRole("button", { name: /Copy Monday/ }).click();
    await page.getByRole("button", { name: "Yes, copy" }).click();
    await page.waitForURL(/notice=hours_copied/);
    await expect(page.getByText("Monday's hours are copied to Tuesday to Friday.")).toBeVisible();
  });

  test("blocked time: add leave, see the list, remove it", async ({ page }) => {
    const day = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    await page.goto("/app/settings?section=blocked");
    await page.getByLabel("From").fill(`${day}T08:00`);
    await page.getByLabel("Until").fill(`${day}T17:00`);
    await page.getByLabel(/Reason/).fill("E2E leave");
    await page.getByRole("button", { name: "Block this time" }).click();
    await page.waitForURL(/notice=block_added/);
    const item = page.getByRole("listitem").filter({ hasText: "E2E leave" });
    await expect(item).toContainText("08:00 to 17:00");
    await item.getByRole("button", { name: /Remove/ }).click();
    await expect(page.getByText("The block is removed.")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "E2E leave" })).toHaveCount(0);
  });

  test("retention: the explanation is shown and a legal hold can be set and cleared", async ({ page }) => {
    await page.goto("/app/settings?section=retention");
    await expect(page.getByText("never deletes any record by itself")).toBeVisible();
    const row = page.getByRole("listitem").filter({ hasText: "Financial records" });
    await row.getByText("Change").click();
    await row.getByRole("switch", { name: "Legal hold" }).check();
    await row.getByLabel("Keep for (years)").fill("7");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Financial records" })).toContainText("Keep for 7 years, legal hold on");
    const again = page.getByRole("listitem").filter({ hasText: "Financial records" });
    await again.getByText("Change").click();
    await again.getByRole("switch", { name: "Legal hold" }).uncheck();
    await again.getByLabel("Keep for (years)").fill("");
    await again.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Financial records" })).toContainText("Kept indefinitely");
  });

  test("templates, staff and connections show yes/no status and no secret", async ({ page }) => {
    await page.goto("/app/settings?section=information");
    await expect(page.getByText("Wording is draft until reviewed by the practice and a legal advisor")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Staff accounts" })).toBeVisible();
    await expect(page.getByText("Email provider")).toBeVisible();
    const html = await page.content();
    expect(html).not.toMatch(/service_role|eyJ[A-Za-z0-9_-]{20,}/); // no key or token
  });
});

test.describe("settings as the admin", () => {
  test.skip(!ADMIN, "set E2E_ADMIN_STATE");
  test.use({ storageState: ADMIN });

  test("sees the values without forms, and may still manage blocked time", async ({ page }) => {
    await page.goto("/app/settings");
    await expect(page.getByText("Only the practitioner can change settings")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save practice details" })).toHaveCount(0);
    await page.goto("/app/settings?section=payment");
    await expect(page.getByRole("button", { name: "Review and save" })).toHaveCount(0);
    await page.goto("/app/settings?section=blocked");
    await expect(page.getByRole("button", { name: "Block this time" })).toBeVisible();
    await page.goto("/app/settings?section=retention");
    await expect(page.getByText("visible to the practitioner only")).toBeVisible();
  });
});

test.describe("settings as the bookkeeper", () => {
  test.skip(!BOOKKEEPER, "set E2E_BOOKKEEPER_STATE");
  test.use({ storageState: BOOKKEEPER });

  test("gets a 404", async ({ page }) => {
    const res = await page.goto("/app/settings");
    expect(res?.status()).toBe(404);
  });
});
