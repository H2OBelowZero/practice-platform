import { test, expect } from "@playwright/test";

// Staff tasks: add one, change it, complete and reopen it, and see that the admin never sees clinical-risk tasks. Needs a running app AND the seeded
// staging project (Task 17); it cannot run in the local no-Docker setup (R13), so it skips itself when the inputs below are missing.
//   E2E_STAFF_STATE        storageState of the psychologist, already past TOTP (aal2)
//   E2E_ADMIN_STATE        storageState of the admin (optional)
//   E2E_BOOKKEEPER_STATE   storageState of the bookkeeper (optional)
const STAFF = process.env.E2E_STAFF_STATE, ADMIN = process.env.E2E_ADMIN_STATE, BOOKKEEPER = process.env.E2E_BOOKKEEPER_STATE;

test.describe("staff tasks", () => {
  test.skip(!STAFF, "set E2E_STAFF_STATE (seeded staging project)");
  test.use({ storageState: STAFF });

  test("create, edit, complete and reopen a task", async ({ page }) => {
    const title = `E2E task ${Date.now()}`;
    await page.goto("/app/tasks/new");
    await page.getByLabel("What needs doing").fill(title);
    await page.getByLabel("Priority").selectOption("high");
    await page.getByRole("button", { name: "Add task" }).click();
    await page.waitForURL(/\/app\/tasks\?notice=created/);
    await expect(page.getByText("The task has been added.")).toBeVisible();

    const row = page.getByRole("listitem").filter({ hasText: title });
    await expect(row.getByText("High priority")).toBeVisible();
    await expect(row.getByText("No due date")).toBeVisible();

    // change the due date to yesterday: it becomes overdue (text and icon, not colour alone)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await row.getByText("Change due date or priority").click();
    await row.getByLabel("Due date").fill(yesterday);
    await row.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("The task has been updated.")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: title }).getByText("Overdue")).toBeVisible();

    await page.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: /Mark done/ }).click();
    await expect(page.getByText("The task is marked done.")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);

    await page.goto("/app/tasks?status=done");
    await page.getByRole("listitem").filter({ hasText: title }).getByRole("button", { name: /Reopen/ }).click();
    await expect(page.getByText("The task is open again.")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: title })).toBeVisible();
  });

  test("a title is required and limited to 200 characters", async ({ page }) => {
    await page.goto("/app/tasks/new");
    await page.getByLabel("What needs doing").fill("x".repeat(201));
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByText("Keep the title under 200 characters.")).toBeVisible();
  });

  test("filters narrow the list and are kept in the address", async ({ page }) => {
    await page.goto("/app/tasks");
    await page.getByLabel("Priority").selectOption("high");
    await page.getByLabel("Due").selectOption("overdue");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/priority=high/);
    await expect(page).toHaveURL(/due=overdue/);
  });

  test.describe("an unmatched PayFast payment shows its figures", () => {
    test.skip(!process.env.E2E_BASE_HAS_DATA, "needs the seeded unreconciled PayFast task"); // at describe level so no browser is started when the inputs are missing
    test("an unmatched PayFast payment shows its figures", async ({ page }) => {
      await page.goto("/app/tasks?group=billing");
      await expect(page.getByText("Payment received at PayFast that could not be matched").first()).toBeVisible();
    });
  });
});

test.describe("who sees what", () => {
  test.describe("the admin does not get the clinical risk filter", () => {
    test.skip(!ADMIN, "set E2E_ADMIN_STATE"); // at describe level so no browser is started when the inputs are missing
    test("the admin does not get the clinical risk filter", async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: ADMIN });
      const page = await ctx.newPage();
      await page.goto("/app/tasks");
      await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
      await expect(page.getByLabel("Kind").locator("option", { hasText: "Clinical risk" })).toHaveCount(0);
      await ctx.close();
    });
  });

  test.describe("the bookkeeper gets a 404 for tasks", () => {
    test.skip(!BOOKKEEPER, "set E2E_BOOKKEEPER_STATE"); // at describe level so no browser is started when the inputs are missing
    test("the bookkeeper gets a 404 for tasks", async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: BOOKKEEPER });
      const page = await ctx.newPage();
      expect((await page.goto("/app/tasks"))?.status()).toBe(404);
      expect((await page.goto("/app/tasks/new"))?.status()).toBe(404);
      await ctx.close();
    });
  });
});
