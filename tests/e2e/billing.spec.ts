import { test, expect } from "@playwright/test";

// Staff billing: invoice an attended appointment, issue it, record an EFT payment (and meet the duplicate warning), print the receipt, and
// see that the bookkeeper cannot write. Needs a running app AND the seeded staging project (Task 17); it cannot run in the local no-Docker setup
// (R13), so it skips itself when the inputs below are missing.
//   E2E_STAFF_STATE        storageState of the psychologist, already past TOTP (aal2)
//   E2E_BOOKKEEPER_STATE   storageState of the bookkeeper (optional: enables the read-only check)
//   E2E_ATTENDED_APPT_ID   id of an ATTENDED appointment that has no live invoice yet
const STAFF = process.env.E2E_STAFF_STATE, BOOKKEEPER = process.env.E2E_BOOKKEEPER_STATE, APPT = process.env.E2E_ATTENDED_APPT_ID;

test.describe("staff billing", () => {
  test.skip(!STAFF || !APPT, "set E2E_STAFF_STATE and E2E_ATTENDED_APPT_ID (seeded staging project)");
  test.use({ storageState: STAFF });

  test("invoice an attended appointment, issue, pay, repeat-payment warning, receipt, void is blocked", async ({ page }) => {
    await page.goto(`/app/billing/new?appointment=${APPT}`);
    await expect(page.getByLabel("Description")).toHaveValue(/ — /); // "<session type> — <date>"
    await expect(page.getByLabel("Quantity")).toHaveValue("1");
    await page.getByRole("button", { name: "Create draft invoice" }).click();

    await page.waitForURL(/\/app\/billing\/[0-9a-f-]{36}\?notice=created/);
    const invoiceUrl = page.url().split("?")[0];
    await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

    // one live invoice per appointment: going back to the appointment's invoice form lands on this invoice
    await page.goto(`/app/billing/new?appointment=${APPT}`);
    await page.waitForURL(/notice=exists/);
    await expect(page.getByText("This appointment already has an invoice")).toBeVisible();

    await page.goto(invoiceUrl);
    await page.getByRole("button", { name: "Issue invoice" }).click();
    await page.waitForURL(/notice=issued/);
    await expect(page.getByText("Issued", { exact: true }).first()).toBeVisible();

    // lines are frozen once issued: no edit form
    await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);

    // a first payment of R 100,00
    const pay = async () => {
      await page.getByLabel("Method").selectOption("eft");
      await page.getByLabel("Amount received (rand)").fill("100,00");
      await page.getByLabel("Bank reference").fill("E2E-REF-1");
    };
    await pay();
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.waitForURL(/notice=payment/);
    await expect(page.getByText("Part paid", { exact: true }).first()).toBeVisible();

    // the same payment again is flagged, and only "Record anyway" records it
    await pay();
    await page.getByRole("button", { name: "Record payment" }).click();
    await expect(page.getByText("This looks like a repeat")).toBeVisible();
    await expect(page.getByLabel("Bank reference")).toHaveValue("E2E-REF-1"); // the form kept what was typed
    await page.getByLabel("Bank reference").fill("E2E-REF-2"); // changing a field withdraws the offer
    await expect(page.getByRole("button", { name: "Record payment" })).toBeVisible();
    await page.getByRole("button", { name: "Record payment" }).click();
    await page.waitForURL(/notice=payment/);

    // an invoice with payments cannot be voided (no void control for a part paid invoice)
    await expect(page.getByRole("link", { name: "Void invoice" })).toHaveCount(0);

    // printable receipt
    await page.getByRole("link", { name: /^Receipt for/ }).first().click();
    await expect(page.getByRole("heading", { name: "Payment receipt" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Print receipt" })).toBeVisible();
  });
});

test.describe("bookkeeper billing is read-only", () => {
  test.skip(!BOOKKEEPER, "set E2E_BOOKKEEPER_STATE");
  test.use({ storageState: BOOKKEEPER });

  test("sees the list without patient names, cannot open the new invoice form", async ({ page }) => {
    await page.goto("/app/billing");
    await expect(page.getByRole("heading", { name: "Billing", level: 1 })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Patient" })).toHaveCount(0);
    expect(await page.locator('a[href^="/app/patients/"]').count()).toBe(0);
    const res = await page.goto(`/app/billing/new?appointment=${APPT ?? "00000000-0000-4000-8000-000000000000"}`);
    expect(res?.status()).toBe(404);
  });
});
