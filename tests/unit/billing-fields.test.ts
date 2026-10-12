import { describe, it, expect } from "vitest";
import { buildInvoice, parseCreditNoteForm, parseInvoiceForm, parsePaymentForm, type InvoiceFormInput } from "@/lib/billing/input";
import { billingErrorCode } from "@/lib/billing/errors";

const TODAY = "2030-02-01";
const form = (over: Record<string, string> = {}) => ({
  line_desc_0: "Therapy session", line_qty_0: "1", line_price_0: "950", discount: "", dueDate: "2030-02-15", payer: "self", ...over,
});
const field = (r: { ok: boolean; field?: string }) => (r.ok ? undefined : r.field);

describe("field errors name the control (for aria-invalid / aria-describedby)", () => {
  it("invoice form", () => {
    expect(field(parseInvoiceForm(form({ line_price_0: "x" }), TODAY))).toBe("line_price_0");
    expect(field(parseInvoiceForm(form({ line_qty_0: "0" }), TODAY))).toBe("line_qty_0");
    expect(field(parseInvoiceForm(form({ line_desc_0: " ", line_price_0: "5" }), TODAY))).toBe("line_desc_0");
    // the field id follows the row's own key, not its position
    expect(field(parseInvoiceForm({ ...form(), line_desc_7: "B", line_qty_7: "1", line_price_7: "oops" }, TODAY))).toBe("line_price_7");
    expect(field(parseInvoiceForm(form({ discount: "-1" }), TODAY))).toBe("discount");
    expect(field(parseInvoiceForm(form({ dueDate: "2020-01-01" }), TODAY))).toBe("dueDate");
    expect(field(parseInvoiceForm(form({ payer: "x" }), TODAY))).toBe("payer");
    expect(field(parseInvoiceForm(form({ payer: "split" }), TODAY))).toBe("scheme");
    expect(field(parseInvoiceForm({ dueDate: "2030-02-15", payer: "self" }, TODAY))).toBeUndefined();
  });
  it("build, payment and credit note", () => {
    const i: InvoiceFormInput = { lines: [{ description: "x", quantity: 1, unitCents: 1000 }], discountCents: 5000, dueDate: "2030-02-15", payer: "self", schemeCents: null };
    expect(field(buildInvoice(i, { registered: false, rate: 15 }))).toBe("discount");
    expect(field(buildInvoice({ ...i, discountCents: 0, payer: "split", schemeCents: 1000 }, { registered: false, rate: 15 }))).toBe("scheme");
    const pay = (o: Record<string, string>) => ({ method: "eft", amount: "1", reference: "r", receivedOn: TODAY, ...o });
    expect(field(parsePaymentForm(pay({ method: "x" }), TODAY))).toBe("method");
    expect(field(parsePaymentForm(pay({ amount: "0" }), TODAY))).toBe("amount");
    expect(field(parsePaymentForm(pay({ reference: "" }), TODAY))).toBe("reference");
    expect(field(parsePaymentForm(pay({ receivedOn: "2031-01-01" }), TODAY))).toBe("receivedOn");
    expect(field(parseCreditNoteForm({ amount: "x", reason: "r" }, "self"))).toBe("amount");
    expect(field(parseCreditNoteForm({ amount: "1", reason: "" }, "self"))).toBe("reason");
    expect(field(parseCreditNoteForm({ amount: "1", reason: "r" }, "split"))).toBe("portion");
  });
  it("the parsed values carry the payer and the trimmed due date the action sends to the database", () => {
    const r = parseInvoiceForm(form({ payer: "medical_aid", dueDate: " 2030-02-15 " }), TODAY);
    expect(r.ok && r.value).toMatchObject({ payer: "medical_aid", dueDate: "2030-02-15" });
  });
});

it("lines_mismatch from the database is mapped", () => {
  expect(billingErrorCode("lines_mismatch")).toBe("lines_mismatch");
});
