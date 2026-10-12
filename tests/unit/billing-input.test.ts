import { describe, it, expect } from "vitest";
import { buildInvoice, defaultDueDate, lineRows, parseCreditNoteForm, parseInvoiceForm, parsePaymentForm, type InvoiceFormInput } from "@/lib/billing/input";

const TODAY = "2030-02-01";
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const err = (r: { ok: boolean; error?: string }) => (r.ok ? "" : r.error);

const form = (over: Record<string, string> = {}) => ({
  line_desc_0: "Therapy session", line_qty_0: "1", line_price_0: "950", discount: "", dueDate: "2030-02-15", payer: "self", ...over,
});

describe("lineRows", () => {
  it("collects indexed rows in numeric order and drops rows that are empty apart from the default quantity", () => {
    const rows = lineRows({ line_desc_10: "B", line_qty_10: "2", line_price_10: "5", line_desc_2: "A", line_qty_2: "1", line_price_2: "1", line_desc_3: "", line_qty_3: "1", line_price_3: " " });
    expect(rows.map((r) => r.description)).toEqual(["A", "B"]);
  });
  it("keeps a row with only a quantity other than 1 (so it is reported, not dropped)", () => {
    expect(lineRows({ line_desc_0: "", line_qty_0: "3", line_price_0: "" })).toHaveLength(1);
  });
  it("ignores unrelated keys and keys with huge indexes", () => {
    expect(lineRows({ foo: "x", line_desc_99999: "x", line_desc_0: "ok", line_qty_0: "1", line_price_0: "1" })).toHaveLength(1);
  });
});

describe("parseInvoiceForm", () => {
  it("parses a one-line self-pay form into cents", () => {
    expect(ok(parseInvoiceForm(form(), TODAY))).toEqual({
      lines: [{ description: "Therapy session", quantity: 1, unitCents: 95000 }], discountCents: 0, dueDate: "2030-02-15", payer: "self", schemeCents: null,
    });
  });
  it("accepts South African and plain amount spellings", () => {
    for (const [s, c] of [["950", 95000], ["950,50", 95050], ["950.5", 95050], ["R 1 234,50", 123450], ["0", 0], ["1000000", 100_000_000]] as const)
      expect(ok(parseInvoiceForm(form({ line_price_0: s }), TODAY)).lines[0].unitCents, s).toBe(c);
  });
  it("rejects unit prices that are over R 1 000 000, negative, have 3 decimals or are not numbers", () => {
    for (const s of ["1000000,01", "1000001", "-5", "9.999", "abc", "1e3", "", "99999999999"]) expect(err(parseInvoiceForm(form({ line_price_0: s }), TODAY)), s).toMatch(/^Line 1: enter a price/);
  });
  it("quantity is a whole number from 1 to 99", () => {
    for (const q of ["1", "2", "99"]) expect(ok(parseInvoiceForm(form({ line_qty_0: q }), TODAY)).lines[0].quantity).toBe(Number(q));
    for (const q of ["0", "100", "-1", "1.5", "x", ""]) expect(err(parseInvoiceForm(form({ line_qty_0: q, line_price_0: "10" }), TODAY)), q).toMatch(/^Line 1: enter a quantity/);
  });
  it("description is 1 to 200 characters after trimming", () => {
    expect(err(parseInvoiceForm(form({ line_desc_0: "   ", line_price_0: "10" }), TODAY))).toMatch(/Line 1: enter a description/);
    expect(ok(parseInvoiceForm(form({ line_desc_0: "x".repeat(200) }), TODAY)).lines[0].description).toHaveLength(200);
    expect(err(parseInvoiceForm(form({ line_desc_0: "x".repeat(201) }), TODAY))).toMatch(/under 200 characters/);
    expect(ok(parseInvoiceForm(form({ line_desc_0: "  padded  " }), TODAY)).lines[0].description).toBe("padded");
  });
  it("needs at least one line and at most 20", () => {
    expect(err(parseInvoiceForm({ dueDate: "2030-02-15", payer: "self" }, TODAY))).toMatch(/at least one line/);
    const many: Record<string, string> = form();
    for (let i = 1; i <= 20; i++) { many[`line_desc_${i}`] = "x"; many[`line_qty_${i}`] = "1"; many[`line_price_${i}`] = "1"; }
    expect(err(parseInvoiceForm(many, TODAY))).toMatch(/at most 20/);
  });
  it("the error names the failing line number among several", () => {
    expect(err(parseInvoiceForm(form({ line_desc_1: "B", line_qty_1: "1", line_price_1: "oops" }), TODAY))).toMatch(/^Line 2:/);
  });
  it("discount: blank is zero, otherwise rand with up to 2 decimals", () => {
    expect(ok(parseInvoiceForm(form({ discount: "" }), TODAY)).discountCents).toBe(0);
    expect(ok(parseInvoiceForm(form({ discount: "100,25" }), TODAY)).discountCents).toBe(10025);
    expect(err(parseInvoiceForm(form({ discount: "-1" }), TODAY))).toMatch(/discount/);
    expect(err(parseInvoiceForm(form({ discount: "1.234" }), TODAY))).toMatch(/discount/);
  });
  it("due date must be a real date, not in the past; today is fine", () => {
    expect(ok(parseInvoiceForm(form({ dueDate: TODAY }), TODAY)).dueDate).toBe(TODAY);
    expect(err(parseInvoiceForm(form({ dueDate: "2030-01-31" }), TODAY))).toMatch(/in the past/);
    for (const d of ["", "2030-02-30", "01/02/2030", "tomorrow"]) expect(err(parseInvoiceForm(form({ dueDate: d }), TODAY)), d).toMatch(/Choose a due date/);
  });
  it("payer must be one of the three; split needs a scheme portion, the others ignore it", () => {
    expect(err(parseInvoiceForm(form({ payer: "bogus" }), TODAY))).toMatch(/who pays/);
    expect(err(parseInvoiceForm(form({ payer: "split" }), TODAY))).toMatch(/medical aid portion/);
    expect(err(parseInvoiceForm(form({ payer: "split", scheme: "x" }), TODAY))).toMatch(/medical aid portion/);
    expect(ok(parseInvoiceForm(form({ payer: "split", scheme: "600" }), TODAY)).schemeCents).toBe(60000);
    expect(ok(parseInvoiceForm(form({ payer: "medical_aid", scheme: "600" }), TODAY)).schemeCents).toBeNull();
  });
});

describe("buildInvoice (the server computes every figure)", () => {
  const input = (over: Partial<InvoiceFormInput> = {}): InvoiceFormInput => ({
    lines: [{ description: "Therapy", quantity: 2, unitCents: 50000 }], discountCents: 10000, dueDate: "2030-02-15", payer: "self", schemeCents: null, ...over,
  });
  const VAT = { registered: true, rate: 15 };

  it("totals with discount and VAT (VAT-exclusive prices), self pay", () => {
    expect(ok(buildInvoice(input(), VAT))).toMatchObject({ subtotal: 100000, discount: 10000, vat: 13500, total: 103500, scheme: 0, patientPortion: 103500 });
  });
  it("no VAT when the practice is not registered", () => {
    expect(ok(buildInvoice(input(), { registered: false, rate: 15 }))).toMatchObject({ vat: 0, total: 90000 });
  });
  it("medical aid: the whole total is the scheme portion", () => {
    expect(ok(buildInvoice(input({ payer: "medical_aid" }), VAT))).toMatchObject({ total: 103500, scheme: 103500, patientPortion: 0 });
  });
  it("split: patient portion is total minus scheme, and the two always add up", () => {
    const b = ok(buildInvoice(input({ payer: "split", schemeCents: 60000 }), VAT));
    expect(b).toMatchObject({ scheme: 60000, patientPortion: 43500 });
    expect(b.scheme + b.patientPortion).toBe(b.total);
  });
  it("split: scheme portion must be above zero and below the total", () => {
    for (const s of [0, 103500, 200000]) expect(err(buildInvoice(input({ payer: "split", schemeCents: s }), VAT)), String(s)).toMatch(/more than R 0,00 and less than the invoice total \(R 1 035,00\)/);
  });
  it("discount above the subtotal is refused (not clamped)", () => {
    expect(err(buildInvoice(input({ discountCents: 100001 }), VAT))).toMatch(/discount cannot be more than the subtotal \(R 1 000,00\)/);
    expect(ok(buildInvoice(input({ discountCents: 100000 }), VAT))).toMatchObject({ discount: 100000, vat: 0, total: 0 });
  });
  it("VAT rounds half-up to the cent and every figure is an integer", () => {
    const b = ok(buildInvoice(input({ lines: [{ description: "x", quantity: 3, unitCents: 3333 }], discountCents: 0 }), VAT)); // 9999 * 15% = 1499.85
    expect(b).toMatchObject({ subtotal: 9999, vat: 1500, total: 11499 });
    for (const v of [b.subtotal, b.discount, b.vat, b.total, b.scheme, b.patientPortion]) expect(Number.isInteger(v)).toBe(true);
  });
  it("amounts beyond the database int range are refused with a message, not thrown", () => {
    const big = { description: "x", quantity: 99, unitCents: 100_000_000 };
    expect(err(buildInvoice(input({ lines: [big, big, big], discountCents: 0 }), VAT))).toMatch(/too large/);
  });
  it("lines go out in the database column names", () => {
    expect(ok(buildInvoice(input(), VAT)).lines).toEqual([{ description: "Therapy", quantity: 2, unit_cents: 50000 }]);
  });
});

describe("parsePaymentForm", () => {
  const pay = (over: Record<string, string> = {}) => ({ method: "eft", amount: "950", reference: "REF-1", receivedOn: TODAY, ...over });
  it("parses a valid EFT", () => {
    expect(ok(parsePaymentForm(pay(), TODAY))).toEqual({ method: "eft", amountCents: 95000, reference: "REF-1", receivedOn: TODAY, allowDuplicate: false });
  });
  it("only eft, cash and card_machine (payfast and medical_aid are not manual)", () => {
    for (const m of ["payfast", "medical_aid", "", "bitcoin"]) expect(err(parsePaymentForm(pay({ method: m }), TODAY)), m).toMatch(/Choose how the payment/);
  });
  it("amount: positive, at most 2 decimals", () => {
    for (const a of ["0", "0,00", "-1", "1.234", "", "abc"]) expect(err(parsePaymentForm(pay({ amount: a }), TODAY)), a).toMatch(/amount received/);
    expect(ok(parsePaymentForm(pay({ amount: "0,01" }), TODAY)).amountCents).toBe(1);
  });
  it("reference is required for eft and card machine, optional for cash", () => {
    expect(err(parsePaymentForm(pay({ reference: "  " }), TODAY))).toMatch(/bank reference/);
    expect(err(parsePaymentForm(pay({ method: "card_machine", reference: "" }), TODAY))).toMatch(/card slip/);
    expect(ok(parsePaymentForm(pay({ method: "cash", reference: "" }), TODAY)).reference).toBeNull();
    expect(err(parsePaymentForm(pay({ reference: "x".repeat(101) }), TODAY))).toMatch(/under 100/);
  });
  it("received date: real, today or earlier", () => {
    expect(ok(parsePaymentForm(pay({ receivedOn: "2030-01-01" }), TODAY)).receivedOn).toBe("2030-01-01");
    expect(err(parsePaymentForm(pay({ receivedOn: "2030-02-02" }), TODAY))).toMatch(/future/);
    expect(err(parsePaymentForm(pay({ receivedOn: "2030-13-01" }), TODAY))).toMatch(/Choose the date/);
  });
  it("'Record anyway' arrives as allowDuplicate", () => {
    expect(ok(parsePaymentForm(pay({ allowDuplicate: "true" }), TODAY)).allowDuplicate).toBe(true);
    expect(ok(parsePaymentForm(pay({ allowDuplicate: "no" }), TODAY)).allowDuplicate).toBe(false);
  });
});

describe("parseCreditNoteForm", () => {
  it("needs a positive amount and a reason of 1 to 300 characters", () => {
    expect(ok(parseCreditNoteForm({ amount: "150", reason: " goodwill " }))).toEqual({ amountCents: 15000, reason: "goodwill" });
    expect(err(parseCreditNoteForm({ amount: "0", reason: "x" }))).toMatch(/credit amount/);
    expect(err(parseCreditNoteForm({ amount: "10", reason: "  " }))).toMatch(/reason/);
    expect(err(parseCreditNoteForm({ amount: "10", reason: "x".repeat(301) }))).toMatch(/under 300/);
    expect(ok(parseCreditNoteForm({ amount: "10", reason: "x".repeat(300) })).reason).toHaveLength(300);
  });
});

it("default due date is 14 days on, crossing month and year ends", () => {
  expect(defaultDueDate("2030-02-01")).toBe("2030-02-15");
  expect(defaultDueDate("2030-12-25")).toBe("2031-01-08");
  expect(defaultDueDate("2032-02-20")).toBe("2032-03-05"); // leap year
});
