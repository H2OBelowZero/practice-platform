import { describe, it, expect } from "vitest";
import { computeInvoice } from "@/lib/billing/invoice";

type In = Parameters<typeof computeInvoice>[0];
const one = (unitCents: number, o: Partial<In> = {}) =>
  computeInvoice({ lines: [{ quantity: 1, unitCents }], discountCents: 0, vatRegistered: true, vatRate: 15, ...o });

describe("computeInvoice", () => {
  it("totals with discount and VAT (VAT-exclusive prices), VAT on the discounted amount", () => {
    expect(computeInvoice({ lines: [{ quantity: 2, unitCents: 50000 }], discountCents: 10000, vatRegistered: true, vatRate: 15 }))
      .toEqual({ subtotal: 100000, discount: 10000, vat: 13500, total: 103500 });
  });
  it("no VAT when not registered", () => {
    expect(one(95000, { vatRegistered: false })).toEqual({ subtotal: 95000, discount: 0, vat: 0, total: 95000 });
  });
  it("zero VAT rate", () => expect(one(95000, { vatRate: 0 })).toMatchObject({ vat: 0, total: 95000 }));
  it("sums several lines", () => {
    expect(computeInvoice({ lines: [{ quantity: 3, unitCents: 1000 }, { quantity: 1, unitCents: 250 }], discountCents: 0, vatRegistered: false, vatRate: 15 }).subtotal).toBe(3250);
  });
  it("no lines is a zero invoice", () => {
    expect(computeInvoice({ lines: [], discountCents: 0, vatRegistered: true, vatRate: 15 })).toEqual({ subtotal: 0, discount: 0, vat: 0, total: 0 });
  });

  describe("rounding is half-up to the cent", () => {
    it.each([
      [33333, 5000], // 4999.95 -> 5000
      [10, 2],       // 1.5 -> 2
      [30, 5],       // 4.5 -> 5
      [3, 0],        // 0.45 -> 0
      [4, 1],        // 0.6 -> 1
      [34, 5],       // 5.1 -> 5
      [1, 0],        // 0.15 -> 0
      [100, 15], [95000, 14250],
      [99999, 15000], // 14999.85 -> 15000
      [66667, 10000], // 10000.05 -> 10000
    ])("%i cents @15%% -> vat %i", (c, vat) => {
      const r = one(c);
      expect(r.vat).toBe(vat);
      expect(r.total).toBe(c + vat);
    });
    it("fractional rates are exact (14.5%)", () => expect(one(1000, { vatRate: 14.5 }).vat).toBe(145));
    it("exact .5 at 7.5%: 20 cents -> 1.5 -> 2", () => expect(one(20, { vatRate: 7.5 }).vat).toBe(2));
  });

  describe("discount", () => {
    it("larger than the subtotal clamps to the subtotal: total 0, no VAT, identity kept", () => {
      expect(computeInvoice({ lines: [{ quantity: 1, unitCents: 10000 }], discountCents: 50000, vatRegistered: true, vatRate: 15 }))
        .toEqual({ subtotal: 10000, discount: 10000, vat: 0, total: 0 });
    });
    it("equal to the subtotal", () => expect(one(10000, { discountCents: 10000 })).toMatchObject({ vat: 0, total: 0 }));
    it("total = subtotal - discount + vat always", () => {
      for (const [u, d] of [[12345, 1], [12345, 999], [1, 0], [100001, 50000]]) {
        const r = one(u, { discountCents: d });
        expect(r.total).toBe(r.subtotal - r.discount + r.vat);
      }
    });
  });

  describe("large values", () => {
    it("R2 million + VAT still fits", () => expect(one(200_000_000)).toMatchObject({ vat: 30_000_000, total: 230_000_000 }));
    it("exact at the int ceiling", () => expect(one(2_147_483_647, { vatRegistered: false }).total).toBe(2_147_483_647));
    it("quantity x unit overflowing the DB int throws", () => {
      expect(() => computeInvoice({ lines: [{ quantity: 1_000_000, unitCents: 1_000_000 }], discountCents: 0, vatRegistered: false, vatRate: 15 })).toThrow("invalid_amount");
    });
    it("total + VAT over the int ceiling throws", () => expect(() => one(2_000_000_000)).toThrow("invalid_amount"));
    it("unsafe integers throw", () => expect(() => one(Number.MAX_SAFE_INTEGER + 1)).toThrow("invalid_amount"));
  });

  describe("invalid input throws invalid_amount", () => {
    const ok: In = { lines: [{ quantity: 1, unitCents: 100 }], discountCents: 0, vatRegistered: true, vatRate: 15 };
    const cases: [string, In][] = [
      ["negative unit", { ...ok, lines: [{ quantity: 1, unitCents: -1 }] }],
      ["negative quantity", { ...ok, lines: [{ quantity: -1, unitCents: 100 }] }],
      ["fractional unit", { ...ok, lines: [{ quantity: 1, unitCents: 10.5 }] }],
      ["fractional quantity", { ...ok, lines: [{ quantity: 1.5, unitCents: 100 }] }],
      ["NaN unit", { ...ok, lines: [{ quantity: 1, unitCents: NaN }] }],
      ["Infinity", { ...ok, lines: [{ quantity: 1, unitCents: Infinity }] }],
      ["negative discount", { ...ok, discountCents: -1 }],
      ["fractional discount", { ...ok, discountCents: 0.5 }],
      ["negative rate", { ...ok, vatRate: -15 }],
      ["NaN rate", { ...ok, vatRate: NaN }],
      ["Infinite rate", { ...ok, vatRate: Infinity }],
      ["rate with 3 decimals", { ...ok, vatRate: 15.005 }],
    ];
    it.each(cases)("%s", (_n, o) => expect(() => computeInvoice(o)).toThrow("invalid_amount"));
  });
});
