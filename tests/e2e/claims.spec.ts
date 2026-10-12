import { test, expect, type Page } from "@playwright/test";

// Medical aid: a split invoice -> a claim -> submitted (the invoice stays issued) -> the scheme pays (the invoice becomes part paid and the patient portion
// is payable in the portal) -> the rejection path (which raises a staff task). Needs a running app AND the seeded staging project (Task 17); it cannot run
// in the local no-Docker setup (R13), so each block skips itself when its inputs are missing.
//   E2E_STAFF_STATE        storageState of the psychologist, already past TOTP (aal2)
//   E2E_MA_PATIENT_ID      id of a patient with a CURRENT medical aid member (Medical aid tab) and a portal login
//   E2E_PATIENT_STATE      storageState of that patient (optional: enables the portal check)
//   E2E_ADMIN_STATE        storageState of the admin (optional: enables the admin checks)
//   E2E_MA_INVOICE_ID      an ISSUED medical aid invoice of that patient with no claim yet (admin checks)
//   E2E_BOOKKEEPER_STATE   storageState of the bookkeeper (optional: enables the 404 checks)
// The seeded icd10_codes table must contain F41.1.
const STAFF = process.env.E2E_STAFF_STATE, PATIENT_ID = process.env.E2E_MA_PATIENT_ID, PATIENT = process.env.E2E_PATIENT_STATE;
const ADMIN = process.env.E2E_ADMIN_STATE, MA_INVOICE = process.env.E2E_MA_INVOICE_ID, BOOKKEEPER = process.env.E2E_BOOKKEEPER_STATE;
const NOTE = "Submission is tracked manually in this version; submit through your scheme or clearing house and record the outcome here.";
const run = Date.now().toString(36);

/** a split invoice (R 600,00 for the scheme) for the patient, issued; returns its URL */
async function issuedSplitInvoice(page: Page): Promise<string> {
  await page.goto(`/app/billing/new?patient=${PATIENT_ID}`);
  await page.getByLabel("Description").fill("Medical aid session");
  await page.getByLabel("Price each (rand)").fill("1000");
  await page.getByLabel("Who pays").selectOption("split");
  await page.getByLabel("Medical aid portion (rand)").fill("600");
  await page.getByRole("button", { name: "Create draft invoice" }).click();
  await page.waitForURL(/\/app\/billing\/[0-9a-f-]{36}\?notice=created/);
  const url = page.url().split("?")[0];
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await page.getByRole("group", { name: /^Issue invoice/ }).getByRole("button", { name: "Yes, issue this invoice" }).click();
  await page.waitForURL(/notice=issued/);
  return url;
}

/** from an issued invoice: open the claim form, choose F41.1 and create the draft; returns the claim URL */
async function draftClaim(page: Page, invoiceUrl: string): Promise<string> {
  await page.goto(invoiceUrl);
  await page.getByRole("link", { name: "Open medical-aid claim" }).click();
  await page.waitForURL(/\/app\/claims\/new\?invoice=/);
  await expect(page.getByText(NOTE)).toBeVisible();
  await page.getByLabel("Tariff code").fill("86205");
  await page.getByLabel("Search the code list").fill("F41");
  await page.getByRole("checkbox", { name: /^F41\.1/ }).check();
  await expect(page.getByText("Selected (1)")).toBeVisible();
  await page.getByRole("button", { name: "Create draft claim" }).click();
  await page.waitForURL(/\/app\/claims\/[0-9a-f-]{36}\?notice=created/);
  return page.url().split("?")[0];
}

test.describe("medical aid claim workflow", () => {
  test.skip(!STAFF || !PATIENT_ID, "set E2E_STAFF_STATE and E2E_MA_PATIENT_ID (seeded staging project)");
  test.use({ storageState: STAFF });

  test("claim -> submitted (invoice stays issued) -> scheme pays (invoice part paid, patient portion payable)", async ({ page, browser }) => {
    const invoiceUrl = await issuedSplitInvoice(page);
    const claimUrl = await draftClaim(page, invoiceUrl);

    // the clinical label, the manual note and no ICD-10 codes on the list
    await expect(page.getByText("Clinical information").first()).toBeVisible();
    await expect(page.getByText(NOTE)).toBeVisible();
    await expect(page.getByText("F41.1").first()).toBeVisible();

    await page.getByRole("button", { name: "Mark as submitted" }).click();
    await page.getByRole("group", { name: "Mark this claim as submitted?" }).getByRole("button", { name: "Yes, it has been submitted" }).click();
    await page.waitForURL(/notice=submitted/);
    await expect(page.getByText("Submitted", { exact: true }).first()).toBeVisible();

    // submitting a claim does not touch the invoice
    await page.goto(invoiceUrl);
    await expect(page.getByText("Issued", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Part paid", { exact: true })).toHaveCount(0);

    // the list has no diagnosis codes
    await page.goto("/app/claims");
    await expect(page.getByRole("heading", { name: "Claims", level: 1 })).toBeVisible();
    await expect(page.getByText("F41.1")).toHaveCount(0);

    // a reference is required (the browser does not block the empty field: the server message appears); the full R 600,00 settles the scheme side
    await page.goto(claimUrl);
    await page.getByLabel("Amount the scheme paid (rand)").fill("600,00");
    await page.getByRole("button", { name: "Record scheme payment" }).click();
    await page.getByRole("group", { name: "Record this scheme payment?" }).getByRole("button", { name: "Yes, record the payment" }).click();
    await expect(page.getByText("Enter the remittance advice number.").first()).toBeVisible();
    await page.getByLabel("Remittance reference").fill(`E2E-RA-${run}`);
    await page.getByRole("button", { name: "Record scheme payment" }).click();
    await page.getByRole("group", { name: "Record this scheme payment?" }).getByRole("button", { name: "Yes, record the payment" }).click();
    await page.waitForURL(/notice=remitted/);
    await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Scheme payment recorded: claim fully paid")).toBeVisible();

    // the invoice is part paid: the patient portion is what is left
    await page.goto(invoiceUrl);
    await expect(page.getByText("Part paid", { exact: true }).first()).toBeVisible();

    if (PATIENT) {
      const ctx = await browser.newContext({ storageState: PATIENT });
      const portal = await ctx.newPage();
      await portal.goto("/portal/payments");
      await expect(portal.getByRole("button", { name: /^Pay now/ }).first()).toBeVisible(); // scheme portion settled: the patient portion can be paid online
      await expect(portal.getByText(/ICD|diagnos|claim/i)).toHaveCount(0);
      expect((await portal.goto("/app/claims"))?.status()).toBe(404);
      await ctx.close();
    }
  });

  test("rejection needs a reason, raises a staff task that links to the claim, and the claim can be corrected and resubmitted", async ({ page }) => {
    const claimUrl = await draftClaim(page, await issuedSplitInvoice(page));
    const claimId = claimUrl.split("/").pop()!;
    await page.getByRole("button", { name: "Mark as submitted" }).click();
    await page.getByRole("group", { name: "Mark this claim as submitted?" }).getByRole("button", { name: "Yes, it has been submitted" }).click();
    await page.waitForURL(/notice=submitted/);

    await page.getByRole("button", { name: "Mark as rejected" }).click();
    await page.getByRole("group", { name: "Mark this claim as rejected?" }).getByRole("button", { name: "Yes, mark as rejected" }).click();
    await expect(page.getByText("Give the reason the claim was rejected.").first()).toBeVisible();
    await page.getByLabel("Why was it rejected?").fill("Pre-authorisation number missing");
    await page.getByRole("button", { name: "Mark as rejected" }).click();
    await page.getByRole("group", { name: "Mark this claim as rejected?" }).getByRole("button", { name: "Yes, mark as rejected" }).click();
    await page.waitForURL(/notice=rejected/);
    await expect(page.getByText("A follow-up task has been added")).toBeVisible();
    await expect(page.getByText("Reason: Pre-authorisation number missing")).toBeVisible();

    // the claims list points at it
    await page.goto("/app/claims?status=rejected");
    await expect(page.locator(`a[href="/app/claims/${claimId}"]`).first()).toBeVisible();

    // the task (the tasks page arrives with Task 16; until then this is skipped) links to the claim
    const tasks = await page.goto("/app/tasks");
    if (tasks?.status() === 200) await expect(page.locator(`a[href="/app/claims/${claimId}"]`).first()).toBeVisible();

    // correct and submit again; the earlier steps stay on the timeline
    await page.goto(claimUrl);
    await page.getByRole("button", { name: "Return to draft for correction" }).click();
    await page.getByRole("group", { name: "Return this claim to draft?" }).getByRole("button", { name: "Yes, return to draft" }).click();
    await page.waitForURL(/notice=reopened/);
    await page.getByRole("button", { name: "Save edits" }).click();
    await page.waitForURL(/notice=saved/);
    await page.getByRole("button", { name: "Mark as submitted" }).click();
    await page.getByRole("group", { name: "Mark this claim as submitted?" }).getByRole("button", { name: "Yes, it has been submitted" }).click();
    await page.waitForURL(/notice=submitted/);
    await expect(page.getByText("Marked as rejected")).toBeVisible();
    await expect(page.getByText("Returned to draft for correction")).toBeVisible();
  });

  test("the patient's Medical aid tab lists members with a current / expired chip", async ({ page }) => {
    await page.goto(`/app/patients/${PATIENT_ID}?tab=medical-aid`);
    await expect(page.getByRole("heading", { name: "Medical aid", level: 2 })).toBeVisible();
    await expect(page.getByText("Current", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Add member" })).toBeVisible();
    await expect(page.getByRole("button", { name: /delete|remove/i })).toHaveCount(0); // members are end-dated, never deleted
  });
});

test.describe("admin and diagnosis codes", () => {
  test.skip(!ADMIN || !MA_INVOICE, "set E2E_ADMIN_STATE and E2E_MA_INVOICE_ID");
  test.use({ storageState: ADMIN });

  test("the admin opens a draft claim without codes, cannot choose any, and cannot mark it submitted", async ({ page }) => {
    await page.goto(`/app/claims/new?invoice=${MA_INVOICE}`);
    await expect(page.getByText("Diagnosis codes are added by the practitioner.")).toBeVisible();
    await expect(page.getByLabel("Search the code list")).toHaveCount(0);
    await page.getByLabel("Tariff code").fill("86205");
    await page.getByRole("button", { name: "Create draft claim" }).click();
    await page.waitForURL(/\/app\/claims\/[0-9a-f-]{36}\?notice=created/);
    await expect(page.getByText("Not ready to be marked as submitted")).toBeVisible();
    await expect(page.getByText(/added by the practitioner/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark as submitted" })).toHaveCount(0);
  });
});

test.describe("other roles", () => {
  test.skip(!BOOKKEEPER, "set E2E_BOOKKEEPER_STATE");
  test.use({ storageState: BOOKKEEPER });

  test("the bookkeeper gets a 404 on every claims route and no Claims link", async ({ page }) => {
    for (const path of ["/app/claims", "/app/claims/new?invoice=00000000-0000-4000-8000-000000000000", "/app/claims/00000000-0000-4000-8000-000000000000"]) {
      expect((await page.goto(path))?.status(), path).toBe(404);
    }
    await page.goto("/app/billing");
    await expect(page.getByRole("link", { name: "Claims" })).toHaveCount(0);
  });
});
