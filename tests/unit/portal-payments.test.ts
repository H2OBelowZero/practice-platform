import { describe, it, expect } from "vitest";
import {
  buildPortalInvoices, checkoutIdentity, creditText, decideCheckout, hasPortalReceipt, orderInvoices, parsePaidParam, payNowReasonText, receiptView,
  returnState, SCHEME_PENDING_TEXT, summarise, type CreditRow, type InvoiceRow, type PaymentRow, type PortalInvoice,
} from "@/lib/portal/payments";
import { payfastAvailable } from "@/lib/payments/payfast";

const ME = "11111111-1111-4111-8111-111111111111";
const P_ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", P_KID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TODAY = "2031-03-10";

const inv = (o: Partial<InvoiceRow> & { id: string }): InvoiceRow => ({
  number: "INV-" + o.id, patient_id: P_ME, status: "issued", payer_type: "self", issue_date: "2031-03-01", due_date: "2031-03-15",
  total_cents: 95000, scheme_portion_cents: 0, patient_portion_cents: 95000, outstanding_cents: 95000, ...o,
});
const pay = (invoice_id: string, method: string, amount_cents: number, id = invoice_id + method + amount_cents): PaymentRow => ({ id, invoice_id, method, amount_cents, received_on: "2031-03-05" });
const cr = (invoice_id: string, portion: string, amount_cents: number): CreditRow => ({ invoice_id, portion, amount_cents });
const people = [{ id: P_ME, first_name: "Thandi", user_id: ME }, { id: P_KID, first_name: "Sipho", user_id: null }];

describe("buildPortalInvoices", () => {
  it("drops drafts, computes payNowAllowed per invoice from that invoice's own payments and credits", () => {
    const list = buildPortalInvoices({
      invoices: [
        inv({ id: "a" }),
        inv({ id: "b", payer_type: "split", total_cents: 100000, scheme_portion_cents: 70000, patient_portion_cents: 30000, outstanding_cents: 50000, status: "part_paid" }),
        inv({ id: "c", status: "draft" }),
      ],
      payments: [pay("b", "medical_aid", 50000), pay("a", "eft", 1)], credits: [cr("b", "patient", 20000)],
      patients: people, userId: ME, today: TODAY,
    });
    expect(list.map((i) => i.id)).toEqual(["a", "b"]);
    expect(list[0].payNow).toEqual({ allowed: true, amountCents: 94999 });
    // R200 patient goodwill credit does not settle the scheme: refused
    expect(list[1].payNow).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 30000 });
  });
  it("a scheme write-off settles it", () => {
    const [i] = buildPortalInvoices({
      invoices: [inv({ id: "b", payer_type: "split", total_cents: 100000, scheme_portion_cents: 70000, patient_portion_cents: 30000, outstanding_cents: 30000, status: "part_paid" })],
      payments: [pay("b", "medical_aid", 50000)], credits: [cr("b", "scheme", 20000)], patients: people, userId: ME, today: TODAY,
    });
    expect(i.payNow).toEqual({ allowed: true, amountCents: 30000 });
  });
  it("labels invoices that are not the signed-in user's own with the person's first name (a guardian's child)", () => {
    const list = buildPortalInvoices({ invoices: [inv({ id: "a" }), inv({ id: "k", patient_id: P_KID })], payments: [], credits: [], patients: people, userId: ME, today: TODAY });
    expect(list.map((i) => i.forName)).toEqual([null, "Sipho"]);
    const asGuardian = buildPortalInvoices({ invoices: [inv({ id: "k", patient_id: P_KID })], payments: [], credits: [], patients: people, userId: "99999999-9999-4999-8999-999999999999", today: TODAY });
    expect(asGuardian[0].forName).toBe("Sipho");
  });
  it("outstanding is the database's figure for an open invoice and 0 for any other; overdue only when open and past due", () => {
    const list = buildPortalInvoices({
      invoices: [inv({ id: "a", due_date: "2031-03-09" }), inv({ id: "d", due_date: "2031-03-10" }), inv({ id: "p", status: "paid", due_date: "2031-01-01", outstanding_cents: 0 }), inv({ id: "v", status: "void", outstanding_cents: 55 })],
      payments: [], credits: [], patients: people, userId: ME, today: TODAY,
    });
    expect(list.map((i) => [i.id, i.outstandingCents, i.overdue, i.open])).toEqual([["a", 95000, true, true], ["d", 95000, false, true], ["p", 0, false, false], ["v", 0, false, false]]);
  });
});

describe("orderInvoices and summarise", () => {
  const mk = (id: string, status: string, due: string, issued: string, outstanding: number, payNow: PortalInvoice["payNow"]): PortalInvoice => ({
    id, number: id, status, payerType: "self", issueDate: issued, dueDate: due, totalCents: 1000, outstandingCents: outstanding, overdue: false,
    open: status === "issued" || status === "part_paid", forName: null, payNow,
  });
  const list = [
    mk("late", "issued", "2031-04-01", "2031-03-01", 30000, { allowed: true, amountCents: 30000 }),
    mk("old", "paid", "2031-01-01", "2031-01-01", 0, { allowed: false, reason: "paid", amountCents: 0 }),
    mk("soon", "part_paid", "2031-03-12", "2031-02-01", 20000, { allowed: true, amountCents: 20000 }),
    mk("scheme", "issued", "2031-03-20", "2031-03-02", 70000, { allowed: false, reason: "scheme_pending", amountCents: 70000 }),
    mk("new", "paid", "2031-03-01", "2031-03-02", 0, { allowed: false, reason: "paid", amountCents: 0 }),
  ];
  it("open first by due date, the rest newest first", () => {
    const { open, closed } = orderInvoices(list);
    expect(open.map((i) => i.id)).toEqual(["soon", "scheme", "late"]);
    expect(closed.map((i) => i.id)).toEqual(["new", "old"]);
  });
  it("summary: outstanding, payable now, waiting for the medical aid", () => {
    expect(summarise(list)).toEqual({ outstandingCents: 120000, payableNowCents: 50000, awaitingSchemeCents: 70000, openCount: 3 });
  });
  it("nothing open => zeros", () => {
    expect(summarise([])).toEqual({ outstandingCents: 0, payableNowCents: 0, awaitingSchemeCents: 0, openCount: 0 });
    expect(summarise(list.filter((i) => !i.open))).toEqual({ outstandingCents: 0, payableNowCents: 0, awaitingSchemeCents: 0, openCount: 0 });
  });
  it("sums are exact integers", () => {
    const s = summarise([mk("x", "issued", "d", "i", 1, { allowed: true, amountCents: 1 }), mk("y", "issued", "d", "i", 2, { allowed: true, amountCents: 2 })]);
    expect(s.outstandingCents).toBe(3);
  });
});

describe("the PayFast return page (?paid=)", () => {
  it("only a uuid selects an invoice; anything else is ignored", () => {
    const id = "3F6B2C1E-5A7D-4E2B-9C1A-0D4F6A8B2C3D";
    expect(parsePaidParam(id)).toBe(id.toLowerCase());
    expect(parsePaidParam([id, "x"])).toBe(id.toLowerCase());
    for (const bad of [undefined, "", "1", "INV-00001", "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3", `${id} `, "' or 1=1 --", "../../etc", [] as string[]]) expect(parsePaidParam(bad), String(bad)).toBeNull();
  });
  it("says 'confirming' until the invoice is paid or a PayFast payment row exists, 'paid' after, nothing for an unknown invoice", () => {
    expect(returnState(undefined, [])).toBe("none");
    expect(returnState({ status: "issued" }, [])).toBe("confirming");
    expect(returnState({ status: "part_paid" }, [{ method: "eft" }])).toBe("confirming");
    expect(returnState({ status: "paid" }, [])).toBe("paid");
    expect(returnState({ status: "issued" }, [{ method: "payfast" }])).toBe("paid");
  });
});

describe("decideCheckout (the server's decision; pure part of startPayfastCheckout)", () => {
  const self = { number: "INV-00007", status: "issued", payer_type: "self", total_cents: 95000, scheme_portion_cents: 0, patient_portion_cents: 95000 };
  const split = { number: "INV-00008", status: "part_paid", payer_type: "split", total_cents: 100000, scheme_portion_cents: 70000, patient_portion_cents: 30000 };

  it("the amount is the outstanding balance computed from the rows, nothing else", () => {
    expect(decideCheckout({ invoice: self, payments: [{ method: "eft", amountCents: 20000 }], credits: [{ portion: "patient", amountCents: 5000 }] })).toEqual({ ok: true, amountCents: 70000, number: "INV-00007" });
  });
  it("a figure the page showed is only a check: equal passes, different is refused with the current balance, and it is never the charged amount", () => {
    const base = { invoice: self, payments: [], credits: [] };
    expect(decideCheckout({ ...base, seenCents: 95000 })).toMatchObject({ ok: true, amountCents: 95000 });
    const stale = decideCheckout({ ...base, seenCents: 1 });
    expect(stale).toMatchObject({ ok: false, code: "stale" });
    expect(stale.ok === false && stale.error).toContain("R 950,00");
    expect(decideCheckout({ ...base, seenCents: 999999999 })).toMatchObject({ ok: false, code: "stale" }); // a bigger claimed amount is not charged either
  });
  it("medical aid / split: refused while the scheme side is open, with the plain explanation", () => {
    const r = decideCheckout({ invoice: split, payments: [{ method: "medical_aid", amountCents: 50000 }], credits: [{ portion: "patient", amountCents: 20000 }] });
    expect(r).toEqual({ ok: false, code: "scheme_pending", error: SCHEME_PENDING_TEXT });
    expect(decideCheckout({ invoice: split, payments: [{ method: "medical_aid", amountCents: 50000 }], credits: [{ portion: "scheme", amountCents: 20000 }] })).toMatchObject({ ok: true, amountCents: 30000 });
  });
  it("unknown, draft, paid, void and overpaid invoices are refused", () => {
    expect(decideCheckout({ invoice: null, payments: [], credits: [] })).toMatchObject({ ok: false, code: "not_found" });
    expect(decideCheckout({ invoice: { ...self, status: "draft" }, payments: [], credits: [] })).toMatchObject({ ok: false, code: "not_found" });
    expect(decideCheckout({ invoice: { ...self, status: "paid" }, payments: [{ method: "eft", amountCents: 95000 }], credits: [] })).toMatchObject({ ok: false, code: "paid" });
    expect(decideCheckout({ invoice: { ...self, status: "void" }, payments: [], credits: [] })).toMatchObject({ ok: false, code: "not_payable" });
    expect(decideCheckout({ invoice: self, payments: [{ method: "eft", amountCents: 96000 }], credits: [] })).toMatchObject({ ok: false, code: "paid" });
  });
});

describe("checkoutIdentity", () => {
  it("first name of the verified user and their email, trimmed", () => {
    expect(checkoutIdentity("  Thandi Nkosi ", " t@example.co.za ")).toEqual({ name: "Thandi", email: "t@example.co.za" });
    expect(checkoutIdentity("Madonna", "m@x.za")).toEqual({ name: "Madonna", email: "m@x.za" });
  });
  it("missing values become empty strings (buildCheckout leaves them out of the form)", () => {
    expect(checkoutIdentity(null, undefined)).toEqual({ name: "", email: "" });
    expect(checkoutIdentity("   ", "")).toEqual({ name: "", email: "" });
  });
});

describe("payfastAvailable (friendly 'online payment not available' instead of a crash)", () => {
  const ok = { PAYFAST_MERCHANT_ID: "10000100", PAYFAST_MERCHANT_KEY: "46f0cd694581a", PAYFAST_PASSPHRASE: "x", APP_URL: "https://x.example", NODE_ENV: "production" };
  it("complete production setup", () => expect(payfastAvailable(ok)).toBe(true));
  it("missing merchant id or key", () => {
    expect(payfastAvailable({ ...ok, PAYFAST_MERCHANT_ID: undefined })).toBe(false);
    expect(payfastAvailable({ ...ok, PAYFAST_MERCHANT_KEY: "  " })).toBe(false);
  });
  it("no passphrase: only the sandbox may run without one", () => {
    expect(payfastAvailable({ ...ok, PAYFAST_PASSPHRASE: undefined })).toBe(false);
    expect(payfastAvailable({ ...ok, PAYFAST_PASSPHRASE: undefined, PAYFAST_SANDBOX: "true" })).toBe(true);
    expect(payfastAvailable({ ...ok, PAYFAST_PASSPHRASE: undefined, PAYFAST_SANDBOX: "false" })).toBe(false);
  });
  it("production needs APP_URL; development does not", () => {
    expect(payfastAvailable({ ...ok, APP_URL: undefined })).toBe(false);
    expect(payfastAvailable({ ...ok, APP_URL: undefined, NODE_ENV: "development" })).toBe(true);
  });
});

describe("receipts", () => {
  const practice = { name: "Dr Example Psychology", registration_no: "PR 0123456", hpcsa_no: "PS 0123456" };
  const payment = { method: "payfast", amount_cents: 123450, received_on: "2031-03-05", reference: null, gateway_ref: "PF-777" };
  it("formats everything printed on the receipt", () => {
    const r = receiptView({ practice, invoice: { number: "INV-00009", total_cents: 123450, vat_cents: 16102 }, patient: { first_name: "Thandi", last_name: "Nkosi" }, payment });
    expect(r).toEqual({
      practiceName: "Dr Example Psychology", practiceNumber: "PR 0123456", hpcsaNumber: "PS 0123456", invoiceNumber: "INV-00009", patientName: "Thandi Nkosi",
      dateReceived: expect.stringContaining("2031"), method: "PayFast (online)", reference: "PF-777", amount: "R 1 234,50",
      vatNote: "Invoice INV-00009 totals R 1 234,50, which includes VAT of R 161,02.",
    });
  });
  it("no VAT, no practice row, no patient: still a valid receipt", () => {
    const r = receiptView({ practice: null, invoice: { number: "INV-1", total_cents: 100, vat_cents: 0 }, patient: null, payment: { ...payment, method: "eft", reference: "MY REF", gateway_ref: null } });
    expect(r).toMatchObject({ practiceName: "Practice", practiceNumber: null, hpcsaNumber: null, patientName: null, method: "EFT", reference: "MY REF", vatNote: "No VAT is charged on invoice INV-1." });
  });
  it("blank practice numbers are not printed; a reference-less payment has none", () => {
    const r = receiptView({ practice: { name: "P", registration_no: "", hpcsa_no: null }, invoice: { number: "I", total_cents: 1, vat_cents: 0 }, patient: null, payment: { ...payment, method: "cash", gateway_ref: null } });
    expect(r).toMatchObject({ practiceNumber: null, hpcsaNumber: null, reference: null });
  });
  it("the scheme's remittance has no portal receipt; the patient's own payments do", () => {
    expect(hasPortalReceipt("medical_aid")).toBe(false);
    for (const m of ["payfast", "eft", "cash", "card_machine"]) expect(hasPortalReceipt(m), m).toBe(true);
  });
});

describe("wording", () => {
  it("the scheme-pending sentence is the agreed plain text", () => {
    expect(SCHEME_PENDING_TEXT).toBe("Your medical aid is still processing its part of this invoice — you'll be able to pay your portion once it has been settled.");
    expect(payNowReasonText("scheme_pending")).toBe(SCHEME_PENDING_TEXT);
    expect(payNowReasonText("paid")).toMatch(/paid/);
    expect(payNowReasonText("not_payable")).toMatch(/cannot be paid online/);
    expect(payNowReasonText(undefined)).toMatch(/cannot be paid online/);
  });
  it("credit notes are described without the staff's free-text reason", () => {
    expect(creditText("scheme")).toMatch(/medical aid/);
    expect(creditText("patient")).toBe("Discount or write-off");
  });
});
