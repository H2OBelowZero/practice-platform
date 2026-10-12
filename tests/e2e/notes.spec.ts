import { test, expect } from "@playwright/test";

// Workflow: the psychologist starts a SOAP note from a patient's Clinical notes tab, types (autosave after 3 s), flags moderate risk, signs it through the
// inline confirmation, sees the read-only view, adds an addendum (the note becomes amended) and opens an earlier draft version; an admin gets a 404 for the
// note and has no Clinical notes tab. Needs a running app AND the seeded staging project (Task 17); it cannot run in the local no-Docker setup (R13), so it
// skips itself when the inputs below are missing.
//   E2E_PATIENT_RECORD_ID   the id of a patient record (/app/patients/<id>)
//   E2E_STAFF_STATE         path to a Playwright storageState of the psychologist, already past TOTP (aal2)
//   E2E_ADMIN_STATE         path to a Playwright storageState of the admin, already past TOTP (aal2)
const RECORD = process.env.E2E_PATIENT_RECORD_ID, STAFF = process.env.E2E_STAFF_STATE, ADMIN = process.env.E2E_ADMIN_STATE;
const TEXT = "E2E subjective text";

test.describe("clinical notes", () => {
  test.skip(!RECORD || !STAFF || !ADMIN, "set E2E_PATIENT_RECORD_ID, E2E_STAFF_STATE and E2E_ADMIN_STATE (seeded staging project)");

  test("create, autosave, sign, addendum; the admin gets a 404", async ({ browser }) => {
    const psy = await (await browser.newContext({ storageState: STAFF })).newPage();

    // 1. create a SOAP note from the patient's Clinical notes tab
    await psy.goto(`/app/patients/${RECORD}?tab=notes`);
    await expect(psy.getByRole("heading", { level: 2, name: "Clinical notes" })).toBeVisible();
    await psy.getByRole("link", { name: "New note" }).click();
    await expect(psy.getByRole("heading", { level: 1, name: "New clinical note" })).toBeVisible();
    await psy.getByLabel("Template").selectOption({ label: "SOAP (Subjective, Objective, Assessment, Plan)" });
    await psy.getByRole("button", { name: "Start note" }).click();
    await psy.waitForURL(/\/app\/notes\/[0-9a-f-]{36}$/);
    const noteUrl = psy.url();
    await expect(psy).toHaveTitle(/Clinical note/); // no patient name in the title
    await expect(psy.getByText("Draft", { exact: true })).toBeVisible();

    // 2. autosave after the 3 s pause, and the text survives a reload
    await psy.getByLabel("Subjective").fill(TEXT);
    await expect(psy.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
    await expect(psy.getByRole("status").filter({ hasText: /Saved at \d\d:\d\d/ })).toBeVisible({ timeout: 10_000 });
    await psy.reload();
    await expect(psy.getByLabel("Subjective")).toHaveValue(TEXT);
    expect(psy.url()).not.toContain("E2E"); // note text never appears in a URL

    // 3. moderate risk: the note says it prompts assessment and does not diagnose
    await expect(psy.getByText(/Risk flags prompt your professional assessment; they do not diagnose/)).toBeVisible();
    await psy.getByLabel("Risk level").selectOption("moderate");
    await expect(psy.getByRole("status").filter({ hasText: /Saved at \d\d:\d\d/ })).toBeVisible({ timeout: 10_000 });

    // 4. sign: inline confirmation first (nothing is signed by the first click), then the read-only view
    await psy.getByRole("button", { name: "Sign note" }).click();
    await expect(psy.getByText(/Signing makes the note permanent/)).toBeVisible();
    await psy.getByRole("button", { name: "Keep editing" }).click();
    await expect(psy.getByLabel("Subjective")).toBeVisible();
    await psy.getByRole("button", { name: "Sign note" }).click();
    await psy.getByRole("button", { name: "Sign and lock note" }).click();
    await expect(psy.getByText("The note is signed.")).toBeVisible();
    await expect(psy.getByText("Signed", { exact: true })).toBeVisible();
    await expect(psy.getByText(TEXT)).toBeVisible();
    await expect(psy.getByLabel("Subjective")).toHaveCount(0); // read-only: no textarea

    // 5. addendum: the note becomes amended and the original text stays
    await psy.getByLabel("Addendum").fill("Corrected the session date.");
    await psy.getByRole("button", { name: "Add addendum" }).click();
    await expect(psy.getByText("The addendum was added to the note.")).toBeVisible();
    await expect(psy.getByText("Amended", { exact: true })).toBeVisible();
    await expect(psy.getByText("Corrected the session date.")).toBeVisible();
    await expect(psy.getByText(TEXT)).toBeVisible();

    // 6. version history lists drafts without text; the text appears only after asking
    await expect(psy.getByRole("heading", { name: "Version history" })).toBeVisible();
    await psy.getByRole("button", { name: "Show this version" }).first().click();
    await expect(psy.getByRole("button", { name: "Hide this version" }).first()).toBeVisible();

    // 7. the note appears in the list as amended
    await psy.goto(`/app/patients/${RECORD}?tab=notes`);
    await expect(psy.getByRole("row", { name: /Amended/ }).first()).toBeVisible();

    // 8. the admin gets a 404 for the note and the new-note page, and has no Clinical notes tab
    const admin = await (await browser.newContext({ storageState: ADMIN })).newPage();
    expect((await admin.goto(noteUrl))?.status()).toBe(404);
    expect((await admin.goto(`/app/patients/${RECORD}/notes/new`))?.status()).toBe(404);
    await admin.goto(`/app/patients/${RECORD}`);
    await expect(admin.getByRole("link", { name: "Clinical notes" })).toHaveCount(0);
  });
});
