import { test, expect } from "@playwright/test";

// Portal Payments: outstanding summary, Pay now (the form that is posted to PayFast), a medical aid invoice whose scheme part is still open,
// the PayFast return page, receipts, and another person's invoice. Needs a running app AND the seeded staging project (Task 17); it cannot run in
// the local no-Docker setup (R13), so each block skips itself when its inputs are missing. It never reaches PayFast: the POST is intercepted.
//   E2E_PATIENT_STATE       storageState of a patient
//   E2E_SELF_INVOICE_ID     an ISSUED self-pay invoice of that patient with something outstanding
//   E2E_SPLIT_INVOICE_ID    an ISSUED split invoice of that patient whose scheme portion has not been settled
//   E2E_PAID_INVOICE_ID     an invoice of that patient with a payment by the patient (its receipt is opened)
//   E2E_PAID_PAYMENT_ID     the id of that payment
//   E2E_OTHER_INVOICE_ID    an invoice that belongs to someone else (must be a 404)
//   E2E_GUARDIAN_STATE      storageState of a guardian with permissions.pay on a child that has an invoice
//   E2E_CHILD_NAME          the child's first name
const PATIENT = process.env.E2E_PATIENT_STATE, SELF = process.env.E2E_SELF_INVOICE_ID, SPLIT = process.env.E2E_SPLIT_INVOICE_ID;
const PAID = process.env.E2E_PAID_INVOICE_ID, PAID_PAYMENT = process.env.E2E_PAID_PAYMENT_ID, OTHER = process.env.E2E_OTHER_INVOICE_ID;
const GUARDIAN = process.env.E2E_GUARDIAN_STATE, CHILD = process.env.E2E_CHILD_NAME;

test.describe("patient payments", () => {
  test.skip(!PATIENT || !SELF, "set E2E_PATIENT_STATE and E2E_SELF_INVOICE_ID (seeded staging project)");
  test.use({ storageState: PATIENT });

  test("shows what is outstanding and posts a PayFast form for the invoice's balance", async ({ page }) => {
    await page.goto("/portal/payments");
    await expect(page.getByRole("heading", { name: "Payments", level: 1 })).toBeVisible();
    await expect(page.getByTestId("amount-outstanding")).toContainText(/^R /);
    const card = page.locator("li", { has: page.locator(`a[href="/portal/payments/${SELF}"]`) });
    await expect(card.getByText(/You will be taken to PayFast to pay R /)).toBeVisible();

    // PayFast is never contacted: the form post is intercepted and its fields are inspected
    let posted: URLSearchParams | undefined;
    await page.route(/payfast\.co\.za\/eng\/process/, async (route) => {
      posted = new URLSearchParams(route.request().postData() ?? "");
      await route.fulfill({ status: 200, contentType: "text/html", body: "<p>PayFast (intercepted)</p>" });
    });
    await card.getByRole("button", { name: /^Pay now/ }).click();
    await page.waitForURL(/payfast\.co\.za/);
    expect(posted?.get("m_payment_id")).toBe(SELF);
    expect(posted?.get("amount")).toMatch(/^\d+\.\d{2}$/);
    expect(posted?.get("notify_url")).toMatch(/\/api\/payfast\/itn$/);
    expect(posted?.get("signature")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("the PayFast return page shows stored status only", async ({ page }) => {
    await page.goto(`/portal/payments?paid=${SELF}`);
    // still unpaid in the database: the page does not claim otherwise
    await expect(page.getByText("We're confirming your payment. This usually takes a minute; refresh this page.")).toBeVisible();
    await expect(page.getByText("Paid, thank you.")).toHaveCount(0);
    await page.goto("/portal/payments?paid=not-a-uuid");
    await expect(page.getByText("We're confirming your payment.")).toHaveCount(0);
  });

  test("the invoice page lists lines and totals, and another person's invoice is a 404", async ({ page }) => {
    await page.goto(`/portal/payments/${SELF}`);
    await expect(page.getByRole("heading", { name: "What this invoice is for" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Totals" })).toBeVisible();
    const res = await page.goto(`/portal/payments/${OTHER ?? "00000000-0000-4000-8000-000000000000"}`);
    expect(res?.status()).toBe(404);
  });
});

test.describe("medical aid invoice with the scheme part still open", () => {
  test.skip(!PATIENT || !SPLIT, "set E2E_PATIENT_STATE and E2E_SPLIT_INVOICE_ID");
  test.use({ storageState: PATIENT });

  test("explains why there is no Pay now", async ({ page }) => {
    await page.goto("/portal/payments");
    const card = page.locator("li", { has: page.locator(`a[href="/portal/payments/${SPLIT}"]`) });
    await expect(card.getByText("Your medical aid is still processing its part of this invoice", { exact: false })).toBeVisible();
    await expect(card.getByRole("button", { name: /Pay now/ })).toHaveCount(0);
    await page.goto(`/portal/payments/${SPLIT}`);
    await expect(page.getByRole("button", { name: /Pay now/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Your medical aid and your part" })).toBeVisible();
  });
});

test.describe("receipts", () => {
  test.skip(!PATIENT || !PAID || !PAID_PAYMENT, "set E2E_PATIENT_STATE, E2E_PAID_INVOICE_ID and E2E_PAID_PAYMENT_ID");
  test.use({ storageState: PATIENT });

  test("a payment has a printable receipt; a payment id from another invoice is a 404", async ({ page }) => {
    await page.goto(`/portal/payments/${PAID}/receipts/${PAID_PAYMENT}`);
    await expect(page.getByRole("heading", { name: "Payment receipt" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Print receipt" })).toBeVisible();
    const res = await page.goto(`/portal/payments/${SELF ?? "00000000-0000-4000-8000-000000000000"}/receipts/${PAID_PAYMENT}`);
    expect(res?.status()).toBe(404);
  });
});

test.describe("guardian payments", () => {
  test.skip(!GUARDIAN || !CHILD, "set E2E_GUARDIAN_STATE and E2E_CHILD_NAME");
  test.use({ storageState: GUARDIAN });

  test("each invoice is labelled with the child's first name", async ({ page }) => {
    await page.goto("/portal/payments");
    await expect(page.getByText(`For ${CHILD}`).first()).toBeVisible();
  });
});
