import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { e2eReady, SKIP_MESSAGE } from "./helpers/roles";
import { addMedicalAidMember, createPatientWithLogin, invoiceBalance, issuedInvoice, openTasks, paymentsOf } from "./helpers/db";
import { fillEft } from "./helpers/flows";
import { itnBody, postSignedItnFromHere, raiseUnreconciled, recordPayfastPayment } from "./helpers/itn";
import { contextFor, signInAs } from "./helpers/ui";

// Workflow C (spec sections 6 and 9): payments and reconciliation.
//   self-pay invoice (R1 000): manual EFT part payment -> repeat-entry warning -> second payment -> credit note -> PayFast pays the rest
//   (database-level ITN step, helpers/itn.ts) -> the invoice is paid -> a later PayFast payment that no longer fits raises ONE reconciliation task
//   split invoice (R1 000, R800 scheme): claim drafted and submitted (invoice still issued) -> scheme remittance -> invoice part paid, patient
//   portion payable.
test.describe.serial("workflow C: payments and reconciliation", () => {
  test.skip(!e2eReady(), SKIP_MESSAGE());

  const password = `E2e-Passw0rd-${Date.now()}`;
  const run = Date.now().toString(36);
  let who: Awaited<ReturnType<typeof createPatientWithLogin>>;
  let patient: BrowserContext, p: Page, staff: BrowserContext, s: Page;
  let selfId = "", selfUrl = "", splitId = "", splitUrl = "", claimUrl = "";

  test.beforeAll(async ({ browser }) => {
    who = await createPatientWithLogin("c", password);
    selfId = await issuedInvoice({ patientId: who.patientId, totalCents: 100000, description: "E2E self-pay session" });
    selfUrl = `/app/billing/${selfId}`;
    patient = await browser.newContext();
    p = await patient.newPage();
    await signInAs(p, "patientA", { email: who.email, password });
    staff = await contextFor(browser, "psychologist");
    s = await staff.newPage();
  });
  test.afterAll(async () => { await patient?.close(); await staff?.close(); });

  test("1. manual EFT part payment makes the invoice part paid", async () => {
    await s.goto(selfUrl);
    await fillEft(s, "400,00", `E2E-${run}-1`);
    await s.getByRole("button", { name: "Record payment" }).click();
    await s.waitForURL(/notice=payment/);
    await expect(s.getByText("Part paid", { exact: true }).first()).toBeVisible();
    expect(await invoiceBalance(selfId)).toMatchObject({ status: "part_paid", paid_cents: 40000, outstanding_cents: 60000 });
  });

  test("2. entering the same payment again asks for confirmation; a different reference goes through", async () => {
    await fillEft(s, "400,00", `E2E-${run}-1`);
    await s.getByRole("button", { name: "Record payment" }).click();
    await expect(s.getByText("This looks like a repeat")).toBeVisible();
    expect(await paymentsOf(selfId)).toHaveLength(1); // nothing was recorded by the warning
    await s.getByLabel("Bank reference").fill(`E2E-${run}-2`);
    await s.getByRole("button", { name: "Record payment" }).click();
    await s.waitForURL(/notice=payment/);
    expect(await invoiceBalance(selfId)).toMatchObject({ paid_cents: 80000, outstanding_cents: 20000 });
  });

  test("3. a credit note reduces what is owed", async () => {
    await s.goto(selfUrl);
    const credits = s.getByRole("region", { name: "Credit notes" });
    await credits.getByLabel("Credit amount (rand)").fill("50,00");
    await credits.getByLabel("Reason").fill("E2E goodwill discount");
    await credits.getByRole("button", { name: "Add credit note" }).click();
    await s.getByRole("button", { name: "Yes, add the credit note" }).click();
    await expect.poll(async () => (await invoiceBalance(selfId)).credit_cents).toBe(5000);
    expect((await invoiceBalance(selfId)).outstanding_cents).toBe(15000);
  });

  test("4. PayFast pays the rest (ITN step at database level) and the invoice is paid; the portal agrees", async () => {
    const { ref } = await recordPayfastPayment(selfId, 15000);
    const again = await recordPayfastPayment(selfId, 15000, ref.slice(3)); // PayFast retries the same notification: a no-op
    expect(again.ref).toBe(ref);
    expect((await paymentsOf(selfId)).filter((x) => x.method === "payfast")).toHaveLength(1);
    expect(await invoiceBalance(selfId)).toMatchObject({ status: "paid", outstanding_cents: 0 });
    await p.goto(`/portal/payments/${selfId}?paid=${selfId}`);
    await expect(p.getByText("Paid, thank you.")).toBeVisible();
  });

  test("5. a validated PayFast payment that no longer fits raises ONE reconciliation task and records no money", async () => {
    const before = (await paymentsOf(selfId)).length;
    const source = await raiseUnreconciled(selfId, 15000, 0, "invoice_not_payable");
    await raiseUnreconciled(selfId, 15000, 0, "invoice_not_payable", source.split(":")[1]); // PayFast retry: still one task
    const tasks = await openTasks(source);
    expect(tasks).toHaveLength(1);
    expect((await paymentsOf(selfId)).length).toBe(before);
    await s.goto("/app/tasks");
    await expect(s.getByText("PayFast payment needs reconciliation").first()).toBeVisible();
  });

  test("6. a correctly signed notification from a non-PayFast address is refused", async () => {
    const pass = process.env.E2E_PAYFAST_PASSPHRASE;
    test.skip(!pass, "set E2E_PAYFAST_PASSPHRASE (and E2E_PAYFAST_MERCHANT_ID, default 10000100) to sign a notification like PayFast would");
    const before = (await paymentsOf(selfId)).length;
    const status = await postSignedItnFromHere(process.env.E2E_BASE_URL || "http://localhost:3000",
      itnBody({ invoiceId: selfId, amountCents: 15000, merchantId: process.env.E2E_PAYFAST_MERCHANT_ID || "10000100", passphrase: pass! }));
    expect(status).toBe(400);
    expect((await paymentsOf(selfId)).length).toBe(before);
  });

  test("7. split invoice: claim drafted and submitted, the invoice stays issued", async () => {
    await addMedicalAidMember(who.patientId);
    splitId = await issuedInvoice({ patientId: who.patientId, payer: "split", totalCents: 100000, schemeCents: 80000, description: "E2E medical aid session" });
    splitUrl = `/app/billing/${splitId}`;
    await s.goto(splitUrl);
    await s.getByRole("link", { name: "Open medical-aid claim" }).click();
    await s.waitForURL(/\/app\/claims\/new\?invoice=/);
    await s.getByLabel("Tariff code").fill("86205");
    await s.getByLabel("Search the code list").fill("F41");
    await s.getByRole("checkbox", { name: /^F41\.1/ }).check();
    await s.getByRole("button", { name: "Create draft claim" }).click();
    await s.waitForURL(/\/app\/claims\/[0-9a-f-]{36}\?notice=created/);
    claimUrl = s.url().split("?")[0];
    await s.getByRole("button", { name: "Mark as submitted" }).click();
    await s.getByRole("group", { name: "Mark this claim as submitted?" }).getByRole("button", { name: "Yes, it has been submitted" }).click();
    await s.waitForURL(/notice=submitted/);
    await s.goto(splitUrl);
    await expect(s.getByText("Issued", { exact: true }).first()).toBeVisible();
    expect((await invoiceBalance(splitId)).status).toBe("issued"); // a submitted claim is not a payment
    await p.goto("/portal/payments");
    await expect(p.getByText(/ICD|diagnos/i)).toHaveCount(0); // nothing clinical in the portal
  });

  test("8. the scheme pays: the invoice is part paid and the patient portion is what remains", async () => {
    await s.goto(claimUrl);
    await s.getByLabel("Amount the scheme paid (rand)").fill("800,00");
    await s.getByLabel("Remittance reference").fill(`E2E-RA-${run}`);
    await s.getByRole("button", { name: "Record scheme payment" }).click();
    await s.getByRole("group", { name: "Record this scheme payment?" }).getByRole("button", { name: "Yes, record the payment" }).click();
    await s.waitForURL(/notice=remitted/);
    expect(await invoiceBalance(splitId)).toMatchObject({ status: "part_paid", paid_cents: 80000, outstanding_cents: 20000 });
    await p.goto(`/portal/payments/${splitId}`);
    await expect(p.getByText("R 200,00").first()).toBeVisible(); // the patient portion
    // pay now is offered (PayFast configured) or the page explains that online payment is unavailable
    await expect(p.getByRole("button", { name: /^Pay now/ }).or(p.getByText(/Online payment is not available right now/))).toBeVisible();
  });
});
