import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { e2eReady, FOLLOW_UP, SKIP_MESSAGE } from "./helpers/roles";
import { appointmentStatus, appointmentsOf, confirmEmail, createConfirmedUser, invoiceBalance, moveToPast, must, patientIdByEmail, svc } from "./helpers/db";
import { recordPayfastPayment } from "./helpers/itn";
import { completeForm, createAndIssueInvoice, requestForm } from "./helpers/flows";
import { contextFor, pickFirstSlot, signInAs, weekdayFrom, zar } from "./helpers/ui";

// Workflow A (spec section 1): a NEW patient registers, books, completes the consent forms; staff confirm, mark the session attended, write
// and sign the note, invoice it; the patient "pays" and sees the invoice paid; the report shows the money.
// Registration is real (the /register page). The confirmation email is bypassed through the admin API (the project keeps "Confirm email" on);
// set E2E_ADMIN_CREATE_PATIENT=1 to skip the register page and create the confirmed account directly (a hosted project's default email
// sender allows only a few messages an hour). The PayFast ITN step is the database call the route makes after its checks (helpers/itn.ts).
// Needs the seeded project (README "Running the end-to-end tests"). Skips itself when E2E_SUPABASE_* is missing.
test.describe.serial("workflow A: new patient to paid invoice", () => {
  test.skip(!e2eReady(), SKIP_MESSAGE());

  const stamp = Date.now();
  const email = `e2e.a.${stamp}@demo.test`, password = `E2e-Passw0rd-${stamp}`;
  let patient: BrowserContext, patientPage: Page, staff: BrowserContext, staffPage: Page;
  let patientId = "", apptId = "", invoiceUrl = "", invoiceId = "";

  test.beforeAll(async ({ browser }) => {
    patient = await browser.newContext();
    patientPage = await patient.newPage();
    staff = await contextFor(browser, "psychologist");
    staffPage = await staff.newPage();
  });
  test.afterAll(async () => { await patient?.close(); await staff?.close(); });

  test("1. the patient registers, confirms the address and signs in", async () => {
    if (process.env.E2E_ADMIN_CREATE_PATIENT) {
      await createConfirmedUser(email, password, "E2E Workflow A");
    } else {
      await patientPage.goto("/register");
      await patientPage.getByLabel("Full name").fill("E2E Workflow A");
      await patientPage.getByLabel("Email address").fill(email);
      await patientPage.getByLabel("Password").fill(password);
      await patientPage.getByRole("button", { name: "Create account" }).click();
      await expect(patientPage.getByText("Check your email to confirm your account")).toBeVisible();
      await confirmEmail(email);
    }
    await signInAs(patientPage, "patientA", { email, password });
    await expect(patientPage).toHaveURL(/\/portal/);
  });

  test("2. the patient books a follow-up and the request waits for the practice", async () => {
    await pickFirstSlot(patientPage, FOLLOW_UP, weekdayFrom(3));
    await patientPage.getByLabel("I accept the booking and cancellation terms").check();
    await patientPage.getByRole("button", { name: "Confirm booking" }).click();
    await patientPage.waitForURL(/\/book/);
    await expect(patientPage.locator("main")).toContainText(/Booking (requested|confirmed)/);
    patientId = await patientIdByEmail(email);
    const appts = await appointmentsOf(patientId);
    expect(appts).toHaveLength(1);
    apptId = appts[0].id;
    expect(["tentative", "confirmed"]).toContain(appts[0].status);
  });

  test("3. staff request the consent forms and the patient completes them", async () => {
    await requestForm(staffPage, patientId, "Informed consent to treatment");
    await requestForm(staffPage, patientId, "Privacy notice");
    await completeForm(patientPage, "Informed consent to treatment", [/I have read and understood/, /I consent to psychological assessment/], "E2E Workflow A");
    await completeForm(patientPage, "Privacy notice", [/I have read this privacy notice/]);
    const consents = must(await svc().from("consents").select("purpose,granted").eq("patient_id", patientId), "consents") as { purpose: string; granted: boolean }[];
    expect(consents.filter((c) => c.granted).map((c) => c.purpose).sort()).toEqual(["privacy_notice", "treatment"]);
  });

  test("4. staff confirm the booking", async () => {
    await staffPage.goto(`/app/calendar/${apptId}`);
    if ((await appointmentStatus(apptId)) === "tentative") {
      await staffPage.getByRole("button", { name: "Confirm appointment" }).click();
      await expect.poll(() => appointmentStatus(apptId)).toBe("confirmed");
    }
    await staffPage.reload();
    await expect(staffPage.getByText("Confirmed", { exact: true }).first()).toBeVisible();
  });

  test("5. the session takes place: staff mark it attended", async () => {
    await moveToPast(apptId); // test shortcut: "Mark attended" is offered only once the session has started
    await staffPage.goto(`/app/calendar/${apptId}`);
    await staffPage.getByRole("button", { name: "Mark attended" }).click();
    await expect.poll(() => appointmentStatus(apptId)).toBe("attended");
  });

  test("6. the psychologist writes and signs the session note", async () => {
    await staffPage.goto(`/app/calendar/${apptId}`);
    await staffPage.getByRole("link", { name: "Write session note" }).click();
    await staffPage.getByLabel("Template").selectOption({ label: "SOAP (Subjective, Objective, Assessment, Plan)" });
    await staffPage.getByRole("button", { name: "Start note" }).click();
    await staffPage.waitForURL(/\/app\/notes\/[0-9a-f-]{36}$/);
    await staffPage.getByLabel("Subjective").fill("E2E workflow A session note.");
    await expect(staffPage.getByRole("status").filter({ hasText: /Saved at \d\d:\d\d/ })).toBeVisible({ timeout: 10_000 });
    await staffPage.getByRole("button", { name: "Sign note" }).click();
    await staffPage.getByRole("button", { name: "Sign and lock note" }).click();
    await expect(staffPage.getByText("The note is signed.")).toBeVisible();
    const notes = must(await svc().from("clinical_notes").select("state,appointment_id").eq("appointment_id", apptId), "note") as { state: string }[];
    expect(notes.map((n) => n.state)).toEqual(["signed"]);
  });

  test("7. staff invoice the session from the appointment and issue the invoice", async () => {
    invoiceUrl = await createAndIssueInvoice(staffPage, `/app/billing/new?appointment=${apptId}`);
    invoiceId = invoiceUrl.split("/").pop()!;
    const bal = await invoiceBalance(invoiceId);
    expect(bal.status).toBe("issued");
    expect(bal.total_cents).toBeGreaterThan(0);
    expect(bal.outstanding_cents).toBe(bal.total_cents);
  });

  test("8. the patient sees the invoice, pays (the PayFast notification, at database level) and it shows paid", async () => {
    await patientPage.goto(`/portal/payments/${invoiceId}`);
    // with PayFast configured there is a Pay now button; without it the page says so (the notice is the documented fallback)
    await expect(patientPage.getByRole("button", { name: /^Pay now/ }).or(patientPage.getByText(/Online payment is not available right now/))).toBeVisible();
    const before = await invoiceBalance(invoiceId);
    const { ref } = await recordPayfastPayment(invoiceId, before.outstanding_cents);
    expect(ref).toMatch(/^PF-/);
    await patientPage.goto(`/portal/payments/${invoiceId}?paid=${invoiceId}`);
    await expect(patientPage.getByText("Paid, thank you.")).toBeVisible();
    await expect(patientPage.getByText("Paid", { exact: true }).first()).toBeVisible();
    expect((await invoiceBalance(invoiceId)).status).toBe("paid");
  });

  test("9. staff see it paid, and the financial report counts the money", async () => {
    await staffPage.goto(invoiceUrl);
    await expect(staffPage.getByText("Paid", { exact: true }).first()).toBeVisible();
    const sa = new Date(Date.now() + 2 * 3600_000).toISOString();
    const monthStart = `${sa.slice(0, 7)}-01`;
    const rows = must(await svc().from("payments").select("amount_cents").eq("method", "payfast").eq("status", "succeeded").gte("received_on", monthStart), "payfast payments this month") as { amount_cents: number }[];
    const total = rows.reduce((n, r) => n + r.amount_cents, 0);
    await staffPage.goto("/app/reports?report=financial&preset=this_month");
    await expect(staffPage.getByRole("heading", { name: "Received by payment method" })).toBeVisible();
    await expect(staffPage.getByRole("row", { name: /PayFast \(online\)/ })).toContainText(zar(total));
  });
});
