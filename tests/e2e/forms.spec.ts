import { test, expect, type Browser, type Page } from "@playwright/test";

// Workflow: staff request the Registration form, the patient fills it in (autosave, resume), submits, staff read it and return it with a note,
// the patient sees the note, and withdraws a consent on the privacy page. Needs a running app AND the seeded staging project (Task 17);
// it cannot run in the local no-Docker setup (R13), so it skips itself when the inputs below are missing.
//   E2E_PATIENT_EMAIL, E2E_PASSWORD   a seeded patient who can log in (no open registration form, no earlier answers)
//   E2E_PATIENT_RECORD_ID             the id of that patient's record (/app/patients/<id>)
//   E2E_STAFF_STATE                   path to a Playwright storageState of the psychologist, already past TOTP (aal2)
const EMAIL = process.env.E2E_PATIENT_EMAIL, PW = process.env.E2E_PASSWORD, RECORD = process.env.E2E_PATIENT_RECORD_ID, STAFF = process.env.E2E_STAFF_STATE;

async function patientPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(EMAIL!);
  await page.getByLabel("Password").fill(PW!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/portal/);
  return page;
}

test.describe("forms and consent", () => {
  test.skip(!EMAIL || !PW || !RECORD || !STAFF, "set E2E_PATIENT_EMAIL, E2E_PASSWORD, E2E_PATIENT_RECORD_ID and E2E_STAFF_STATE (seeded staging project)");

  test("request, autosave and resume, validation, submit, return with a note, resubmit", async ({ browser }) => {
    // 1. staff request the Registration form
    const staff = await (await browser.newContext({ storageState: STAFF })).newPage();
    await staff.goto(`/app/patients/${RECORD}?tab=forms`);
    await staff.getByLabel("Form").selectOption({ label: "Registration" });
    await staff.getByRole("button", { name: "Request form" }).click();
    await expect(staff.getByText("The form has been requested.")).toBeVisible();
    await expect(staff.getByRole("row", { name: /Registration.*Waiting for patient/ })).toBeVisible();

    // 2. the patient finds it under "To complete" and starts filling it in
    const patient = await patientPage(browser);
    await patient.goto("/portal/documents");
    await expect(patient.getByRole("heading", { name: "To complete" })).toBeVisible();
    await patient.getByRole("link", { name: "Registration" }).first().click();
    await expect(patient.getByRole("heading", { level: 1, name: "Registration" })).toBeVisible();

    await patient.getByLabel(/What brings you to therapy/).fill("Feeling stuck at work");
    await expect(patient.getByRole("status").filter({ hasText: /Saved at \d\d:\d\d/ })).toBeVisible({ timeout: 10_000 }); // autosave after 1.5 s

    // 3. leave and come back: the answer is still there (resume)
    await patient.goto("/portal/documents");
    await patient.getByRole("link", { name: "Registration" }).first().click();
    await expect(patient.getByLabel(/What brings you to therapy/)).toHaveValue("Feeling stuck at work");

    // 4. submitting with required fields missing shows a message per field and focuses the first
    await patient.getByRole("button", { name: "Submit" }).click();
    const first = patient.getByLabel(/How do you prefer to be contacted/);
    await expect(first).toHaveAttribute("aria-invalid", "true");
    await expect(first).toBeFocused();
    await expect(patient.getByText(/is required/).first()).toBeVisible();

    // 5. complete the rest and submit
    await first.selectOption({ index: 1 });
    await patient.getByLabel(/safe for us to leave a voicemail/).selectOption({ index: 1 });
    await patient.getByLabel(/have you seen a psychologist/i).selectOption({ label: "No" });
    await patient.getByLabel("Emergency contact: full name").fill("Sam Example");
    await patient.getByLabel("Emergency contact: phone number").fill("082 555 0100");
    await patient.getByLabel("Emergency contact: how are they related to you?").fill("Sibling");
    await patient.getByRole("button", { name: "Submit" }).click();
    await patient.waitForURL(/\/portal\/documents\?notice=submitted/);
    await expect(patient.getByText("Your form has been submitted")).toBeVisible();
    await expect(patient.getByRole("heading", { name: "Completed" })).toBeVisible();

    // 6. staff read it (read-only, by field label) and return it with a note
    await staff.goto(`/app/patients/${RECORD}?tab=forms`);
    await staff.getByRole("link", { name: /View Registration/ }).first().click();
    await expect(staff.getByText("Feeling stuck at work")).toBeVisible();
    await expect(staff.getByRole("heading", { name: "Submission history" })).toBeVisible();
    await staff.getByRole("link", { name: "Return for correction…" }).click();
    await staff.getByLabel("What needs to change?").fill("Please add a phone number we can reach you on during the day.");
    await staff.getByRole("button", { name: "Return form" }).click();
    await expect(staff.getByText("The form has been returned to the patient with your note.")).toBeVisible();

    // 7. the patient sees the note, edits and resubmits
    await patient.goto("/portal/documents");
    await expect(patient.getByText("Please add a phone number we can reach you on during the day.")).toBeVisible();
    await patient.getByRole("link", { name: /Update and resubmit|Update Registration/ }).first().click();
    await patient.getByLabel(/What brings you to therapy/).fill("Feeling stuck at work and at home");
    await patient.getByRole("button", { name: "Submit" }).click();
    await patient.waitForURL(/\/portal\/documents\?notice=submitted/);

    // the staff history now holds both submissions
    await staff.goto(`/app/patients/${RECORD}?tab=forms`);
    await staff.getByRole("link", { name: /View Registration/ }).first().click();
    await expect(staff.locator("details")).toHaveCount(2);
  });

  test("submitting the informed consent form records the consent; the patient can withdraw it with a confirmation", async ({ browser }) => {
    const staff = await (await browser.newContext({ storageState: STAFF })).newPage();
    await staff.goto(`/app/patients/${RECORD}?tab=forms`);
    await staff.getByLabel("Form").selectOption({ label: "Informed consent to treatment" });
    await staff.getByRole("button", { name: "Request form" }).click();
    await expect(staff.getByText("The form has been requested.")).toBeVisible();

    const patient = await patientPage(browser);
    await patient.goto("/portal/documents");
    await patient.getByRole("link", { name: "Informed consent to treatment" }).first().click();
    // required consent boxes are checked by the server as well: unticked gives an error, not a submission
    await patient.getByRole("button", { name: "Submit" }).click();
    await expect(patient.getByLabel(/I consent to psychological assessment/)).toHaveAttribute("aria-invalid", "true");
    await patient.getByLabel(/I have read and understood/).check();
    await patient.getByLabel(/I consent to psychological assessment/).check();
    await patient.getByLabel("Type your full name as your signature").fill("E2E Patient");
    await patient.getByRole("button", { name: "Submit" }).click();
    await patient.waitForURL(/\/portal\/documents\?notice=submitted/);

    // privacy page: given, with a date and the form version; withdrawing asks first
    await patient.goto("/portal/privacy");
    const card = patient.getByRole("listitem").filter({ has: patient.getByRole("heading", { name: "Treatment" }) });
    await expect(card.getByText(/Given on/)).toBeVisible();
    await card.getByRole("link", { name: /Withdraw consent/ }).click();
    const panel = patient.locator("#withdraw-panel");
    await expect(panel).toBeFocused();
    await expect(panel).toContainText("The practice will be notified");
    await expect(panel).toContainText("may affect your care");
    await panel.getByRole("button", { name: "Yes, withdraw my consent" }).click();
    await patient.waitForURL(/\/portal\/privacy\?notice=withdrawn/);
    await expect(card.getByText(/Withdrawn on/)).toBeVisible();

    // staff see the withdrawal in the matrix and as a task
    await staff.goto(`/app/patients/${RECORD}?tab=forms`);
    await expect(staff.getByRole("row", { name: /Treatment.*Withdrawn/ })).toBeVisible();
  });
});
