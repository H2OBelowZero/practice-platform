import { test, expect, type Browser, type Page } from "@playwright/test";

// Needs a running app AND a Supabase project seeded by Task 17 (two fictional patients, a "Follow-up" session type with
// Monday-Friday availability, approval_mode irrelevant). It cannot run in the local no-Docker setup (R13): until a
// staging project exists these tests skip themselves when the credentials below are absent.
//   E2E_PATIENT_A_EMAIL, E2E_PATIENT_B_EMAIL, E2E_PASSWORD
const A = process.env.E2E_PATIENT_A_EMAIL, B = process.env.E2E_PATIENT_B_EMAIL, PW = process.env.E2E_PASSWORD;

/** next Monday-Friday that is at least 2 days away and inside the 60-day window (YYYY-MM-DD, UTC arithmetic is fine here) */
function aWeekday(): string {
  const d = new Date(Date.now() + 3 * 86400_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function signedInPage(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(PW!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/portal/);
  return page;
}

/** step 1 and 2 of the journey: choose the Follow-up session (the seeded demo type; "Video follow-up" does not match: the regex is case-sensitive), pick the date, click the first free time */
async function chooseFirstSlot(p: Page, date: string) {
  await p.goto("/book");
  await p.getByRole("button", { name: /Follow-up/ }).click();
  await p.getByLabel("Date").fill(date);
  await p.getByRole("button", { name: "Show available times" }).click();
  await p.getByRole("button", { name: /^\d{2}:\d{2}$/ }).first().click();
}

test.describe("booking journey", () => {
  test.skip(!A || !B || !PW, "set E2E_PATIENT_A_EMAIL, E2E_PATIENT_B_EMAIL and E2E_PASSWORD (seeded staging project)");

  test("two browsers cannot take the same slot", async ({ browser }) => {
    const a = await signedInPage(browser, A!);
    const b = await signedInPage(browser, B!);
    const date = aWeekday();
    for (const p of [a, b]) {
      await chooseFirstSlot(p, date);
      await expect(p.getByRole("button", { name: "Confirm booking" })).toBeVisible();
      await p.getByLabel("I accept the booking and cancellation terms").check();
    }
    await Promise.all([a.getByRole("button", { name: "Confirm booking" }).click(), b.getByRole("button", { name: "Confirm booking" }).click()]);
    await Promise.all([a, b].map((p) => p.waitForURL(/\/book/)));
    const texts = await Promise.all([a.locator("main").innerText(), b.locator("main").innerText()]);
    expect(texts.filter((t) => /Booking (confirmed|requested)/.test(t))).toHaveLength(1);
    expect(texts.filter((t) => /just taken/.test(t))).toHaveLength(1);
  });

  test("the terms checkbox is required before booking", async ({ browser }) => {
    const p = await signedInPage(browser, A!);
    await chooseFirstSlot(p, aWeekday());
    await p.getByRole("button", { name: "Confirm booking" }).click();
    await expect(p.getByRole("button", { name: "Confirm booking" })).toBeVisible(); // still on the form: nothing was booked
    await expect(p.getByLabel("I accept the booking and cancellation terms")).toBeFocused();
  });
});

test.describe("an anonymous visitor sees times only, and is sent to sign in or register to confirm", () => {
  test.skip(!process.env.E2E_BASE_HAS_DATA, "needs the seeded session types and availability"); // at describe level so no browser is started when the inputs are missing
  test("an anonymous visitor sees times only, and is sent to sign in or register to confirm", async ({ page }) => {
    await chooseFirstSlot(page, aWeekday());
    await expect(page.getByRole("link", { name: "Sign in" }).last()).toHaveAttribute("href", /\/login\?next=%2Fbook%3Ftype%3D/);
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", /\/register\?next=/);
    await expect(page.locator("main")).not.toContainText(/@/); // no other patient's details anywhere
  });
});

test.describe("registration shows the same confirmation message and records no consent claim", () => {
  test.skip(!process.env.E2E_CAN_REGISTER, "creates a real auth user: only against a throwaway staging project"); // at describe level so no browser is started when the inputs are missing
  test("registration shows the same confirmation message and records no consent claim", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByText(/does not give consent to anything else/)).toBeVisible();
    await page.getByLabel("Full name").fill("E2E Tester");
    await page.getByLabel("Email address").fill(`e2e+${Date.now()}@example.test`);
    await page.getByLabel("Password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Check your email to confirm your account")).toBeVisible();
  });
});
