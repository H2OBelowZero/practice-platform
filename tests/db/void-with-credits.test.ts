import { it, expect } from "vitest";
import { withClient } from "./helpers";
import { seed, mkInvoice, as, status } from "./billing-helpers";

// 0026: an invoice with any credit note cannot be voided by hand; full credit still voids it automatically.
const credit = (c: Parameters<typeof as>[0], u: string, i: string, cents: number) =>
  as(c, u, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,$2,'r','patient')", [i, cents]);
const voidBy = (c: Parameters<typeof as>[0], u: string, i: string) => as(c, u, "update invoices set status='void' where id=$1", [i]);

it("a manual void is refused once any credit note exists (psychologist and admin), with the exact error, and the invoice stays issued", () => withClient(async (c) => {
  const { psy, adm, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 10000 });
  await credit(c, psy, i, 2500); // partial
  expect(await status(c, i)).toBe("issued");
  await expect(voidBy(c, psy, i)).rejects.toThrow(/invoice_has_credits/);
  await expect(voidBy(c, adm, i)).rejects.toThrow(/invoice_has_credits/);
  expect(await status(c, i)).toBe("issued");
}));

it("a manual void with no credit notes is still allowed (issued and draft)", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 10000 });
  await voidBy(c, psy, i);
  expect(await status(c, i)).toBe("void");
  const d = await mkInvoice(c, p1, { total: 10000, status: "draft" });
  await voidBy(c, psy, d);
  expect(await status(c, d)).toBe("void");
}));

it("crediting the remainder still voids the invoice automatically (the trusted recompute is not blocked)", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 10000 });
  await credit(c, psy, i, 2500);
  await credit(c, psy, i, 7500);
  expect(await status(c, i)).toBe("void");
  await expect(as(c, psy, "update invoices set status='issued' where id=$1", [i])).rejects.toThrow(/invoice_void_is_final/); // and it stays final
}));

it("the owner (trusted writer) is not held to the new rule, exactly like the payments rule", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 10000 });
  await credit(c, psy, i, 2500);
  await c.query("update invoices set status='void' where id=$1", [i]);
  expect(await status(c, i)).toBe("void");
}));

it("the other void rules are unchanged: payments, open claims and the transition table", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 10000 });
  await as(c, psy, "select record_payment($1,'cash',1000,null,null)", [i]);
  await expect(voidBy(c, psy, i)).rejects.toThrow(/invalid_invoice_transition/); // part_paid cannot be voided by hand
}));
