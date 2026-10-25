import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { e2eReady, SEED, SKIP_MESSAGE } from "./helpers/roles";
import { appointmentsOf, bookAt, bookSoon, createPatientWithLogin, invoiceForAppointment, lateFeeCents, must, openTasks, svc } from "./helpers/db";
import { createAndIssueInvoice } from "./helpers/flows";
import { contextFor, signInAs, weekdayFrom, zar } from "./helpers/ui";

// Workflow B (spec section 6, R29/R30): reschedule and cancel under the cancellation policy.
//   * outside the window the patient may move or cancel freely, with no fee task;
//   * inside the window a patient cannot reschedule (otherwise "move it, then cancel the new one free" would dodge the fee), is warned of the
//     fee before confirming, and the DATABASE raises exactly one "Late cancellation: review fee" task;
//   * staff turn that task into a draft invoice (the task closes), issue it, and the invoice is for the fee.
// The patient and the appointments are created through the service client (a unique patient per run); everything else is the real UI.
test.describe.serial("workflow B: reschedule and cancel under the policy, late fee to invoice", () => {
  test.skip(!e2eReady(), SKIP_MESSAGE());

  const password = `E2e-Passw0rd-${Date.now()}`;
  let who: Awaited<ReturnType<typeof createPatientWithLogin>>;
  let patient: BrowserContext, p: Page, staff: BrowserContext, s: Page;
  let farAppt = "", movedAppt = "", lateAppt = "", fee = 0, taskId = "";

  test.beforeAll(async ({ browser }) => {
    who = await createPatientWithLogin("b", password);
    fee = await lateFeeCents();
    patient = await browser.newContext();
    p = await patient.newPage();
    await signInAs(p, "patientA", { email: who.email, password });
    staff = await contextFor(browser, "psychologist");
    s = await staff.newPage();
  });
  test.afterAll(async () => { await patient?.close(); await staff?.close(); });

  test("1. outside the window: free to cancel is announced, and the patient reschedules", async () => {
    farAppt = await bookAt(who.patientId, SEED.sessionType.followUp, new Date(Date.parse(weekdayFrom(5) + "T07:00:00Z")));
    await p.goto(`/portal/appointments/${farAppt}`);
    await expect(p.getByText("Free to cancel")).toBeVisible();
    await expect(p.getByRole("link", { name: "Reschedule" })).toBeVisible();
    await p.getByRole("link", { name: "Reschedule" }).click();
    await p.getByLabel("New date").fill(weekdayFrom(7));
    await p.getByRole("button", { name: "Show available times" }).click();
    await p.getByRole("button", { name: /^\d{2}:\d{2}$/ }).first().click();
    await p.waitForURL(/\/portal\/appointments\?notice=rescheduled/);
    const appts = await appointmentsOf(who.patientId);
    expect(appts.find((a) => a.id === farAppt)).toMatchObject({ status: "cancelled", cancel_reason: "rescheduled" });
    const live = appts.filter((a) => a.status === "confirmed" || a.status === "tentative");
    expect(live).toHaveLength(1);
    movedAppt = live[0].id;
    expect(await openTasks("late_cancel_fee")).not.toContainEqual(expect.objectContaining({ appointment_id: farAppt }));
  });

  test("2. outside the window the patient cancels without a fee", async () => {
    await p.goto(`/portal/appointments/${movedAppt}`);
    await p.getByRole("link", { name: "Cancel appointment" }).click();
    await p.locator("#cancel-panel").getByRole("button", { name: "Yes, cancel this appointment" }).click();
    await p.waitForURL(/\/portal\/appointments\?notice=cancelled$/);
    expect((await appointmentsOf(who.patientId)).find((a) => a.id === movedAppt)?.status).toBe("cancelled");
    expect((await openTasks("late_cancel_fee")).filter((t) => t.appointment_id === movedAppt)).toHaveLength(0);
  });

  test("3. inside the window: the fee is shown first, rescheduling is refused, cancelling raises ONE fee task", async () => {
    test.skip(fee <= 0, "the practice charges no late-cancellation fee, so there is nothing to test (the seed sets R350)");
    lateAppt = await bookSoon(who.patientId, SEED.sessionType.followUp, 180);
    await p.goto(`/portal/appointments/${lateAppt}`);
    await expect(p.getByText(`Cancelling now may incur a fee of ${zar(fee)}`)).toBeVisible();
    await expect(p.getByRole("link", { name: "Reschedule" })).toHaveCount(0);
    await p.goto(`/portal/appointments/${lateAppt}/reschedule`);
    await expect(p.getByText(/inside the cancellation window/)).toBeVisible();
    await expect(p.getByRole("button", { name: "Show available times" })).toHaveCount(0);

    await p.goto(`/portal/appointments/${lateAppt}`);
    await p.getByRole("link", { name: "Cancel appointment" }).click();
    await p.locator("#cancel-panel").getByRole("button", { name: "Yes, cancel this appointment" }).click();
    await p.waitForURL(/\/portal\/appointments\?notice=cancelled_late/);
    const tasks = (await openTasks("late_cancel_fee")).filter((t) => t.appointment_id === lateAppt);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Late cancellation: review fee", priority: "high", patient_id: who.patientId });
    taskId = tasks[0].id;
  });

  test("4. staff see the task, create the fee invoice from it, and issue it", async () => {
    test.skip(!taskId, "no fee task was raised (see the previous step)");
    await s.goto("/app/tasks");
    await expect(s.getByText("Late cancellation: review fee").first()).toBeVisible();
    await s.goto("/app/billing");
    await expect(s.getByRole("heading", { name: "Fees waiting to be invoiced" })).toBeVisible();
    await s.goto(`/app/billing/new?task=${taskId}`);
    await expect(s.getByLabel("Description")).toHaveValue(/^Late cancellation fee — /);
    await createAndIssueInvoice(s, `/app/billing/new?task=${taskId}`);
    const inv = await invoiceForAppointment(lateAppt);
    expect(inv?.status).toBe("issued");
    const row = must(await svc().from("invoices").select("total_cents").eq("id", inv!.id).single(), "invoice") as { total_cents: number };
    expect(row.total_cents).toBe(fee);
    const task = must(await svc().from("tasks").select("status").eq("id", taskId).single(), "task") as { status: string };
    expect(task.status).toBe("done"); // closed in the same transaction as the invoice
    // asking for the same task again lands on the existing invoice, not a second one
    await s.goto(`/app/billing/new?task=${taskId}`);
    await s.waitForURL(/notice=exists/);
  });
});
