import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient } from "./helpers";
import { seed, mkMaInvoice, as } from "./billing-helpers";

// 0021: a claim that holds scheme payments never goes back to an editable or neutral state, and approved_cents (the money basis) only changes when the claim is accepted.
async function setup(c: Client) {
  const s = await seed(c);
  const { i, m } = await mkMaInvoice(c, s.p1); // total 100000, scheme portion 80000
  const mk = async (cents: number) =>
    (await as(c, s.psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,$3,'{F41.1}') returning id", [i, m, cents])).rows[0].id as string;
  return { ...s, i, m, mk };
}
const setStatus = (c: Client, u: string, id: string, st: string, extra = "") => as(c, u, `update claims set status=$2 ${extra} where id=$1`, [id, st]);
const remit = (c: Client, u: string, claim: string, amount: number, ref: string) => as(c, u, "select record_scheme_remittance($1,$2,$3)", [claim, amount, ref]);
const row = async (c: Client, id: string) => (await c.query("select status, claimed_cents, approved_cents from claims where id=$1", [id])).rows[0];

// ---- IMPORTANT 1: a claim with payments only moves forward -------------------------------------------------------------------------------------------------
it("the review's sequence: submitted, R600 remitted, accepted at R700; it can then not go back to submitted, rejected or draft, and its amount cannot drop below the payments", () => withClient(async (c) => {
  const { psy, adm, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await remit(c, psy, a, 60000, "S1");
  expect((await row(c, a)).status).toBe("part_paid");
  await setStatus(c, adm, a, "accepted", ", approved_cents=70000");
  expect(await row(c, a)).toEqual({ status: "accepted", claimed_cents: 80000, approved_cents: 70000 });
  for (const [st, extra] of [["submitted", ""], ["rejected", ", rejection_reason='x'"], ["draft", ""]] as const)
    await expect(setStatus(c, psy, a, st, extra), `accepted -> ${st}`).rejects.toThrow(/claim_has_payments/);
  await expect(as(c, psy, "update claims set claimed_cents=59999 where id=$1", [a])).rejects.toThrow(/claim_amount_frozen/); // an API user is stopped by the freeze
  await expect(c.query("update claims set claimed_cents=59999 where id=$1", [a])).rejects.toThrow(/claimed_below_remitted/); // and even the owner cannot go under the payments
  expect((await row(c, a)).status).toBe("accepted");
  // forward again: the rest of the approved amount closes it
  await remit(c, psy, a, 10000, "S2");
  expect((await row(c, a)).status).toBe("paid");
}));

it("a part paid claim cannot be submitted, rejected or reopened either", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await remit(c, psy, a, 100, "P1");
  for (const [st, extra] of [["submitted", ""], ["rejected", ", rejection_reason='x'"], ["draft", ""]] as const)
    await expect(setStatus(c, psy, a, st, extra), `part_paid -> ${st}`).rejects.toThrow(/claim_has_payments/);
  await expect(c.query("update claims set status='draft' where id=$1", [a])).rejects.toThrow(/claim_has_payments/); // the owner too
  expect((await row(c, a)).status).toBe("part_paid");
}));

it("a claim with NO payments can still be resubmitted after acceptance (unchanged)", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await setStatus(c, psy, a, "accepted", ", approved_cents=50000");
  await setStatus(c, psy, a, "submitted");
  await setStatus(c, psy, a, "accepted", ", approved_cents=60000"); // a new acceptance may set a new approved amount
  expect((await row(c, a)).approved_cents).toBe(60000);
}));

it("the sibling-claim cap cannot be freed by rejecting a claim that holds payments", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(80000); // the whole scheme portion
  await setStatus(c, psy, a, "submitted");
  await remit(c, psy, a, 60000, "C1");
  await setStatus(c, psy, a, "accepted", ", approved_cents=70000");
  await expect(mk(1)).rejects.toThrow(/claims_exceed_scheme_portion/);
  await expect(setStatus(c, psy, a, "rejected", ", rejection_reason='free the cap'")).rejects.toThrow(/claim_has_payments/);
  await expect(mk(1)).rejects.toThrow(/claims_exceed_scheme_portion/);
}));

// ---- IMPORTANT 2: approved_cents only changes when the claim is accepted ------------------------------------------------------------------------------------
it("approved_cents cannot be changed by any other update: draft, submitted, accepted, part paid or paid, for the API and the owner", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const d = await mk(80000);
  await expect(as(c, psy, "update claims set approved_cents=1000 where id=$1", [d])).rejects.toThrow(/approved_frozen/); // draft
  await setStatus(c, psy, d, "submitted");
  await expect(as(c, psy, "update claims set approved_cents=1000 where id=$1", [d])).rejects.toThrow(/approved_frozen/); // submitted
  await setStatus(c, psy, d, "accepted", ", approved_cents=50000");
  await expect(as(c, psy, "update claims set approved_cents=40000 where id=$1", [d])).rejects.toThrow(/approved_frozen/); // accepted, lowering
  await expect(c.query("update claims set approved_cents=60000 where id=$1", [d])).rejects.toThrow(/approved_frozen/); // accepted, raising, owner
  await remit(c, psy, d, 20000, "A1");
  expect((await row(c, d)).status).toBe("part_paid");
  await expect(as(c, psy, "update claims set approved_cents=80000 where id=$1", [d])).rejects.toThrow(/approved_frozen/); // part paid, raising
  await expect(as(c, psy, "update claims set approved_cents=20000 where id=$1", [d])).rejects.toThrow(/approved_frozen/); // part paid, lowering
  await remit(c, psy, d, 30000, "A2");
  expect((await row(c, d)).status).toBe("paid");
  await expect(as(c, psy, "update claims set approved_cents=80000 where id=$1", [d])).rejects.toThrow(/approved_frozen/); // paid, raising
  await expect(as(c, psy, "update claims set approved_cents=1 where id=$1", [d])).rejects.toThrow(/approved_frozen/); // paid, lowering
  await expect(as(c, psy, "update claims set approved_cents=null where id=$1", [d])).rejects.toThrow(/approved_frozen/);
  expect((await row(c, d)).approved_cents).toBe(50000);
  // writing the same value is not a change
  await as(c, psy, "update claims set approved_cents=50000, preauth_ref='ok' where id=$1", [d]);
}));

it("accepting a claim that already holds payments needs an approved amount of at least what was paid; equal closes it, more leaves it accepted", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(39000), b = await mk(39000), z = await mk(1000);
  for (const x of [a, b, z]) { await setStatus(c, psy, x, "submitted"); await remit(c, psy, x, x === z ? 500 : 30000, `M-${x}`); }
  await expect(setStatus(c, psy, a, "accepted", ", approved_cents=29999")).rejects.toThrow(/approved_below_remitted/);
  expect((await row(c, a)).status).toBe("part_paid");
  await setStatus(c, psy, a, "accepted", ", approved_cents=30000");
  expect((await row(c, a)).status).toBe("paid");
  await setStatus(c, psy, b, "accepted", ", approved_cents=35000");
  expect(await row(c, b)).toEqual({ status: "accepted", claimed_cents: 39000, approved_cents: 35000 });
  // no approved amount given: the claimed amount is the basis and always covers what was paid
  await setStatus(c, psy, z, "accepted");
  expect((await row(c, z)).status).toBe("accepted");
}));

it("the normal flow is unchanged: submitted, accepted with an approved amount, then paid by remittances", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await setStatus(c, psy, a, "accepted", ", approved_cents=50000");
  await remit(c, psy, a, 30000, "N1");
  expect((await row(c, a)).status).toBe("part_paid");
  await remit(c, psy, a, 20000, "N2");
  expect(await row(c, a)).toEqual({ status: "paid", claimed_cents: 80000, approved_cents: 50000 });
}));
