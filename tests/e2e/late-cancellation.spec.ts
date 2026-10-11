import { test, expect, type Browser, type Page } from "@playwright/test";

// Workflow B (part): a patient cancels inside the cancellation window, sees the fee warning first (and cannot reschedule instead: 0010),
// and the practice sees the cancellation and ONE "Late cancellation: review fee" task, created by the database (R29: a task, not an invoice). Needs a running app AND the seeded staging project (Task 17);
// it cannot run in the local no-Docker setup (R13), so it skips itself when the inputs below are missing.
//   E2E_PATIENT_A_EMAIL, E2E_PATIENT_B_EMAIL, E2E_PASSWORD
//   E2E_LATE_APPT_ID    id of a confirmed appointment of patient A that starts within the practice's cancellation window
//   E2E_STAFF_STATE     path to a Playwright storageState of the psychologist, already past TOTP (aal2)
//   E2E_TASKS_UI        set once the staff tasks page (Task 16) exists
const A = process.env.E2E_PATIENT_A_EMAIL, B = process.env.E2E_PATIENT_B_EMAIL, PW = process.env.E2E_PASSWORD;
const APPT = process.env.E2E_LATE_APPT_ID, STAFF = process.env.E2E_STAFF_STATE;

async function signedIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(PW!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/portal/);
  return page;
}

test.describe("late cancellation", () => {
  test.skip(!A || !B || !PW || !APPT, "set E2E_PATIENT_A_EMAIL, E2E_PATIENT_B_EMAIL, E2E_PASSWORD and E2E_LATE_APPT_ID (seeded staging project)");

  test("the patient is warned before confirming, cancels, and the practice sees the task", async ({ browser }) => {
    const patient = await signedIn(browser, A!);
    await patient.goto(`/portal/appointments/${APPT}`);
    // the policy outcome is shown BEFORE anything is confirmed
    await expect(patient.getByText(/Cancelling now may incur a fee of R/)).toBeVisible();

    // inside the window a patient cannot move it (otherwise: reschedule far away, then cancel that one for free): no slot picker, only the policy
    await expect(patient.getByRole("link", { name: "Reschedule" })).toHaveCount(0);
    await patient.goto(`/portal/appointments/${APPT}/reschedule`);
    await expect(patient.getByText(/inside the cancellation window/)).toBeVisible();
    await expect(patient.getByRole("button", { name: "Show available times" })).toHaveCount(0);
    await patient.goto(`/portal/appointments/${APPT}`);

    // inline confirmation panel (no browser dialog)
    await patient.getByRole("link", { name: "Cancel appointment" }).click();
    const panel = patient.locator("#cancel-panel");
    await expect(panel.getByRole("heading", { name: "Cancel this appointment?" })).toBeVisible();
    await expect(panel).toBeFocused();
    await panel.getByRole("button", { name: "Yes, cancel this appointment" }).click();

    await patient.waitForURL(/\/portal\/appointments\?notice=cancelled_late/);
    await expect(patient.getByText(/late cancellation fee/)).toBeVisible();
    await expect(patient.locator("main")).toContainText("Cancelled");

    // a cancelled appointment offers no more actions
    await patient.goto(`/portal/appointments/${APPT}`);
    await expect(patient.getByRole("link", { name: "Cancel appointment" })).toHaveCount(0);
    await expect(patient.getByRole("link", { name: "Reschedule" })).toHaveCount(0);

    // the practice side
    test.skip(!STAFF, "set E2E_STAFF_STATE to also check the staff view");
    const staffCtx = await browser.newContext({ storageState: STAFF });
    const staff = await staffCtx.newPage();
    await staff.goto(`/app/calendar/${APPT}`);
    await expect(staff.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    await expect(staff.getByRole("region", { name: "History" }).or(staff.locator("section[aria-labelledby=history-h]"))).toContainText(/Cancelled/);
    await expect(staff.getByRole("link", { name: "Create invoice" })).toHaveCount(0); // not attended: nothing to invoice
    if (process.env.E2E_TASKS_UI) {
      await staff.goto("/app/tasks");
      await expect(staff.getByText("Late cancellation: review fee").first()).toBeVisible();
    }
  });

  test("another patient cannot open the appointment (404, no data)", async ({ browser }) => {
    const other = await signedIn(browser, B!);
    const res = await other.goto(`/portal/appointments/${APPT}`);
    expect(res?.status()).toBe(404);
    await expect(other.locator("body")).not.toContainText(/Cancelling now|SAST/);
    const res2 = await other.goto(`/portal/appointments/${APPT}/reschedule`);
    expect(res2?.status()).toBe(404);
  });
});
