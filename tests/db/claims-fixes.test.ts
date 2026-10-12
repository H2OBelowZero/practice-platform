import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient } from "./helpers";
import { seed, mkMaInvoice, as, status as invStatus, paid } from "./billing-helpers";

// 0020: one remittance advice can pay several claims, the paid basis is approved-else-claimed, a claim cannot be submitted without a code or an amount,
// and medical aid members are never deleted.
async function setup(c: Client) {
  const s = await seed(c);
  const { i, m } = await mkMaInvoice(c, s.p1); // total 100000, scheme portion 80000
  const mk = async (cents: number, codes = "{F41.1}") =>
    (await as(c, s.psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,$3,$4) returning id", [i, m, cents, codes])).rows[0].id as string;
  return { ...s, i, m, mk };
}
const setStatus = (c: Client, u: string, id: string, st: string, extra = "") => as(c, u, `update claims set status=$2 ${extra} where id=$1`, [id, st]);
const remit = (c: Client, u: string, claim: string, amount: number, ref: string | null) => as(c, u, "select record_scheme_remittance($1,$2,$3)", [claim, amount, ref]);
const cs = async (c: Client, id: string) => (await c.query("select status from claims where id=$1", [id])).rows[0].status as string;
const cpCount = async (c: Client) => (await c.query("select count(*)::int n from claim_payments")).rows[0].n as number;

// ---- IMPORTANT 1: one remittance advice, several claims -----------------------------------------------------------------------------
it("one remittance advice number pays two claims; the plain number is kept in claim_payments.remittance_ref", () => withClient(async (c) => {
  const { psy, i, mk } = await setup(c);
  const a = await mk(30000), b = await mk(50000);
  await setStatus(c, psy, a, "submitted"); await setStatus(c, psy, b, "submitted");
  await remit(c, psy, a, 30000, "RA-9");
  await remit(c, psy, b, 50000, "RA-9"); // used to fail with ref_conflict
  expect(await cs(c, a)).toBe("paid"); expect(await cs(c, b)).toBe("paid");
  expect((await c.query("select remittance_ref, amount_cents from claim_payments order by amount_cents")).rows).toEqual([{ remittance_ref: "RA-9", amount_cents: 30000 }, { remittance_ref: "RA-9", amount_cents: 50000 }]);
  expect((await c.query("select gateway_ref from payments where invoice_id=$1 order by amount_cents", [i])).rows.map((r) => r.gateway_ref)).toEqual([`RA-9#${a}`, `RA-9#${b}`]);
  expect(await paid(c, i)).toBe(80000); // the invoice balance is the sum of both
  expect(await invStatus(c, i)).toBe("part_paid"); // R 200,00 patient portion still open
}));

it("replay of the same reference, claim and amount is a no-op; the same reference with another amount on that claim is ref_conflict", () => withClient(async (c) => {
  const { psy, i, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await remit(c, psy, a, 10000, "X1");
  const before = { cp: await cpCount(c), paid: await paid(c, i), ev: (await c.query("select count(*)::int n from claim_events where claim_id=$1", [a])).rows[0].n };
  await remit(c, psy, a, 10000, " X1 "); // trimmed, same amount: nothing happens
  expect({ cp: await cpCount(c), paid: await paid(c, i), ev: (await c.query("select count(*)::int n from claim_events where claim_id=$1", [a])).rows[0].n }).toEqual(before);
  await expect(remit(c, psy, a, 20000, "X1")).rejects.toThrow(/ref_conflict/);
  await remit(c, psy, a, 20000, "X2"); // a different reference is a different payment
  expect(await paid(c, i)).toBe(30000);
  expect(await cs(c, a)).toBe("part_paid");
}));

it("a reference cannot contain '#' (it separates the claim in the stored payment reference) and is still required", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await expect(remit(c, psy, a, 100, "A#B")).rejects.toThrow(/invalid_ref/);
  await expect(remit(c, psy, a, 100, "  ")).rejects.toThrow(/ref_required/);
  await expect(remit(c, psy, a, 100, null)).rejects.toThrow(/ref_required/);
}));

it("one remittance reference per claim is also enforced by an index (two rows with the same claim and reference cannot exist)", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await remit(c, psy, a, 100, "U1");
  const p = (await c.query("select payment_id from claim_payments where claim_id=$1", [a])).rows[0].payment_id;
  const p2 = (await c.query("insert into payments(invoice_id,method,gateway_ref,amount_cents) select invoice_id,'medical_aid','other#x',100 from claims where id=$1 returning id", [a])).rows[0].id;
  expect(p).not.toBe(p2);
  await expect(c.query("insert into claim_payments(claim_id,payment_id,amount_cents,remittance_ref) values ($1,$2,100,'U1')", [a, p2])).rejects.toThrow(/duplicate key|unique/);
}));

// ---- IMPORTANT 2: the basis is approved, else claimed --------------------------------------------------------------------------------------
it("an accepted claim is paid when the approved amount is remitted, and cannot be overpaid beyond it", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await setStatus(c, psy, a, "accepted", ", approved_cents=50000");
  await remit(c, psy, a, 30000, "B1");
  expect(await cs(c, a)).toBe("part_paid");
  await expect(remit(c, psy, a, 20001, "B2")).rejects.toThrow(/remittance_exceeds_claim/);
  await remit(c, psy, a, 20000, "B2");
  expect(await cs(c, a)).toBe("paid"); // short-paid against the claim, but fully paid against what was approved
}));

it("a claim that has not been accepted is capped at the claimed amount", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(80000);
  await setStatus(c, psy, a, "submitted");
  await expect(remit(c, psy, a, 80001, "C1")).rejects.toThrow(/remittance_exceeds_claim/);
  await remit(c, psy, a, 80000, "C1");
  expect(await cs(c, a)).toBe("paid");
}));

it("accepting a part paid claim: the transition goes to paid when the remittances already cover the approved amount, otherwise to accepted (one status event each)", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(39000), b = await mk(39000);
  for (const x of [a, b]) { await setStatus(c, psy, x, "submitted"); await remit(c, psy, x, 30000, `P-${x}`); expect(await cs(c, x)).toBe("part_paid"); }
  await setStatus(c, psy, a, "accepted", ", approved_cents=30000");
  expect(await cs(c, a)).toBe("paid");
  await setStatus(c, psy, b, "accepted", ", approved_cents=35000");
  expect(await cs(c, b)).toBe("accepted");
  const ev = async (id: string) => (await c.query("select to_status from claim_events where claim_id=$1 and event like 'status:%' order by id", [id])).rows.map((r) => r.to_status);
  expect(await ev(a)).toEqual(["draft", "submitted", "part_paid", "paid"]);
  expect(await ev(b)).toEqual(["draft", "submitted", "part_paid", "accepted"]);
  await remit(c, psy, b, 5000, "P-B2");
  expect(await cs(c, b)).toBe("paid");
  // the move is still limited: part_paid cannot be rejected or reopened
  const d = await mk(1000);
  await setStatus(c, psy, d, "submitted"); await remit(c, psy, d, 500, "P-D");
  await expect(setStatus(c, psy, d, "rejected", ", rejection_reason='x'")).rejects.toThrow(/invalid_claim_transition/);
  await expect(setStatus(c, psy, d, "draft")).rejects.toThrow(/invalid_claim_transition/);
}));

// ---- MINOR: a claim cannot be submitted without a code or an amount ------------------------------------------------------------------------------
it("submitted needs at least one ICD-10 code and an amount above zero, for every writer and on every way in", () => withClient(async (c) => {
  const { psy, adm, i, m } = await setup(c);
  const noCodes = (await as(c, adm, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,1000) returning id", [i, m])).rows[0].id;
  await expect(setStatus(c, adm, noCodes, "submitted")).rejects.toThrow(/icd10_required/);
  await as(c, psy, "update claims set icd10_codes='{F41.1}' where id=$1", [noCodes]);
  await setStatus(c, adm, noCodes, "submitted");
  const zero = (await as(c, psy, "insert into claims(invoice_id,member_id,icd10_codes) values ($1,$2,'{F41.1}') returning id", [i, m])).rows[0].id; // claimed 0 by default
  await expect(setStatus(c, psy, zero, "submitted")).rejects.toThrow(/claimed_amount_required/);
  // the owner (setup / migrations) is held to it too, on insert
  await expect(c.query("insert into claims(invoice_id,member_id,status,claimed_cents) values ($1,$2,'submitted',100)", [i, m])).rejects.toThrow(/icd10_required/);
  await expect(c.query("insert into claims(invoice_id,member_id,status,claimed_cents,icd10_codes) values ($1,$2,'submitted',0,'{F41.1}')", [i, m])).rejects.toThrow(/claimed_amount_required/);
  // a resubmission after a rejection is checked as well (codes cannot have been removed, but the rule is on the transition)
  const r = await (async () => { const x = (await as(c, psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,500,'{F41.1}') returning id", [i, m])).rows[0].id; await setStatus(c, psy, x, "submitted"); await setStatus(c, psy, x, "rejected", ", rejection_reason='n'"); return x; })();
  await setStatus(c, psy, r, "draft");
  await as(c, psy, "update claims set icd10_codes='{}' where id=$1", [r]);
  await expect(setStatus(c, psy, r, "submitted")).rejects.toThrow(/icd10_required/);
}));

// ---- MINOR: members are never deleted ---------------------------------------------------------------------------------------------------------------------------
it("medical aid members cannot be deleted by anyone, not even the owner; end-dating still works", () => withClient(async (c) => {
  const { psy, adm, m, u1 } = await setup(c);
  for (const u of [psy, adm, u1]) await expect(as(c, u, "delete from medical_aid_members where id=$1", [m])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from medical_aid_members where id=$1", [m])).rejects.toThrow(/members cannot be deleted; end-date instead/);
  await expect(c.query("delete from medical_aid_members")).rejects.toThrow(/members cannot be deleted; end-date instead/);
  expect((await as(c, psy, "update medical_aid_members set valid_to='2020-01-01' where id=$1", [m])).rowCount).toBe(1);
  expect((await c.query("select 1 from medical_aid_members where id=$1", [m])).rowCount).toBe(1);
}));

// ---- MINOR: check constraint names the app maps -------------------------------------------------------------------------------------------------------
it("the check constraints behind the claim amount errors have the names the app matches", () => withClient(async (c) => {
  const { psy, mk } = await setup(c);
  const a = await mk(1000);
  await expect(as(c, psy, "update claims set approved_cents=1001 where id=$1", [a])).rejects.toThrow(/violates check constraint "claims_check"/);
  await expect(as(c, psy, "update claims set approved_cents=-1 where id=$1", [a])).rejects.toThrow(/violates check constraint "claims_(approved_cents_)?check"/);
  await expect(as(c, psy, "update claims set claimed_cents=-1 where id=$1", [a])).rejects.toThrow(/violates check constraint "claims_claimed_cents_check"/);
}));
