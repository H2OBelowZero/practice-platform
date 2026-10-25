import { expect, type Page } from "@playwright/test";

// Multi-step staff / patient actions shared by the workflow specs. The strings are the ones the older specs already rely on.

/** Staff: create the draft invoice from an attended appointment (or a late-fee task) form that is already open or reachable at `formUrl`, then issue it. Returns the invoice page URL. */
export async function createAndIssueInvoice(page: Page, formUrl: string): Promise<string> {
  await page.goto(formUrl);
  await page.getByRole("button", { name: "Create draft invoice" }).click();
  await page.waitForURL(/\/app\/billing\/[0-9a-f-]{36}\?notice=created/);
  const url = page.url().split("?")[0];
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await page.getByRole("group", { name: /^Issue invoice/ }).getByRole("button", { name: "Yes, issue this invoice" }).click(); // inline confirmation
  await page.waitForURL(/notice=issued/);
  await expect(page.getByText("Issued", { exact: true }).first()).toBeVisible();
  return url;
}

/** Staff: record a manual EFT payment on the open invoice page. */
export async function fillEft(page: Page, rand: string, reference: string) {
  await page.getByLabel("Method").selectOption("eft");
  await page.getByLabel("Amount received (rand)").fill(rand);
  await page.getByLabel("Bank reference").fill(reference);
}

/** Staff: ask the patient for a form from the patient's Consent & forms tab. */
export async function requestForm(page: Page, patientId: string, formTitle: string) {
  await page.goto(`/app/patients/${patientId}?tab=forms`);
  await page.getByLabel("Form").selectOption({ label: formTitle });
  await page.getByRole("button", { name: "Request form" }).click();
  await expect(page.getByText("The form has been requested.")).toBeVisible();
}

/** Patient: open a requested form from "To complete", tick the given boxes (by label), type the signature if asked, and submit. */
export async function completeForm(page: Page, formTitle: string, tick: RegExp[], signature?: string) {
  await page.goto("/portal/documents");
  await page.getByRole("link", { name: formTitle }).first().click();
  for (const label of tick) await page.getByLabel(label).check();
  if (signature) await page.getByLabel("Type your full name as your signature").fill(signature);
  await page.getByRole("button", { name: "Submit" }).click();
  await page.waitForURL(/\/portal\/documents\?notice=submitted/);
}
