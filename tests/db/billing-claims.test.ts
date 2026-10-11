import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, asService } from "./helpers";
import { seed, mkInvoice, mkMaInvoice, status, paid, count, as, pay } from "./billing-helpers";

/** psychologist creates a draft claim on a medical-aid invoice (scheme 80 000 of 100 000) */
async function setup(c: Client) {
  const s = await seed(c);
  const { i, m } = await mkMaInvoice(c, s.p1);
  const claim = (await as(c, s.psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,80000,'{F41.1}') returning id", [i, m])).rows[0].id as string;
  return { ...s, i, m, claim };
}
const cs = async (c: Client, id: string) => (await c.query("select status from claims where id=$1", [id])).rows[0].status as string;
const setStatus = (c: Client, u: string, id: string, st: string, extra = "") => as(c, u, `update claims set status=$2 ${extra} where id=$1`, [id, st]);
const remit = (c: Client, u: string, claim: string, amount: number, ref: string | null) => as(c, u, "select record_scheme_remittance($1,$2,$3)", [claim, amount, ref]);

// ---- creation rules -------------------------------------------------------------------------------------------------
it("claim creation: invoice must be medical_aid/split, member must be the invoice patient's, amount within the scheme portion, drafts only", () => withClient(async (c) => {
  const { psy, adm, p1, p2, i, m } = await setup(c);
  const ins = (u: string, inv: string, mem: string, amt: number, st = "draft") =>
    as(c, u, "insert into claims(invoice_id,member_id,claimed_cents,status) values ($1,$2,$3,$4) returning id", [inv, mem, amt, st]);
  const self = await mkInvoice(c, p1, { total: 1000 });
  await expect(ins(psy, self, m, 0)).rejects.toThrow(/invoice_not_claimable/);
  const m2 = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'Bonitas','9') returning id", [p2])).rows[0].id;
  await expect(ins(psy, i, m2, 1000)).rejects.toThrow(/member_patient_mismatch/);
  await expect(ins(psy, i, m, 80001)).rejects.toThrow(/claim_exceeds_scheme_portion/);
  await expect(ins(psy, i, m, -1)).rejects.toThrow(/check constraint/);
  for (const st of ["submitted", "accepted", "rejected", "part_paid", "paid"]) await expect(ins(psy, i, m, 1000, st), st).rejects.toThrow(/claim_must_start_as_draft/);
  await expect(ins(psy, "00000000-0000-0000-0000-000000000000", m, 1)).rejects.toThrow(/unknown_invoice/);
  const split = await mkInvoice(c, p1, { total: 1000, scheme: 500, payer: "split" });
  expect((await ins(adm, split, m, 500)).rowCount).toBe(1); // admin may manage claims; split is claimable
  await expect(ins(adm, split, m, 501)).rejects.toThrow(/claim_exceeds_scheme_portion/);
  // the invoice must be issued or part_paid
  for (const st of ["draft", "void", "paid"]) {
    const inv = (await c.query("insert into invoices(patient_id,total_cents,scheme_portion_cents,patient_portion_cents,payer_type,status) values ($1,1000,500,500,'medical_aid',$2) returning id", [p1, st])).rows[0].id;
    await expect(ins(psy, inv, m, 100), st).rejects.toThrow(/invoice_not_claimable/);
  }
  // a service-role caller is held to the same rules
  await expect(asService(c, () => c.query("insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,81000)", [i, m]))).rejects.toThrow(/claim_exceeds_scheme_portion/);
}));

it("claim identity is frozen; the amount only changes while draft; system columns are not writable", () => withClient(async (c) => {
  const { psy, claim, p1 } = await setup(c);
  const other = await mkInvoice(c, p1, { total: 1000, scheme: 500, payer: "split" });
  await expect(as(c, psy, "update claims set invoice_id=$2 where id=$1", [claim, other])).rejects.toThrow(/claim_link_frozen/);
  await expect(as(c, psy, "update claims set id=gen_random_uuid() where id=$1", [claim])).rejects.toThrow(/claim_link_frozen/);
  await expect(as(c, psy, "update claims set claimed_cents=90000 where id=$1", [claim])).rejects.toThrow(/claim_exceeds_scheme_portion/);
  await as(c, psy, "update claims set claimed_cents=70000, preauth_ref='PA1', claim_ref='C1', tariff_code='86205' where id=$1", [claim]);
  await as(c, psy, "update claims set reconciled_at=now(), submitted_at='2000-01-01' where id=$1", [claim]); // silently ignored
  const r = (await c.query("select reconciled_at, submitted_at, claimed_cents from claims where id=$1", [claim])).rows[0];
  expect(r).toEqual({ reconciled_at: null, submitted_at: null, claimed_cents: 70000 });
  await setStatus(c, psy, claim, "submitted");
  await expect(as(c, psy, "update claims set claimed_cents=1 where id=$1", [claim])).rejects.toThrow(/claim_amount_frozen/);
  await expect(as(c, psy, "update claims set icd10_codes='{F32.9}' where id=$1", [claim])).rejects.toThrow(/claim_frozen/);
  await expect(as(c, psy, "update claims set tariff_code='other' where id=$1", [claim])).rejects.toThrow(/claim_frozen/);
  const m2 = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'B','2') returning id", [p1])).rows[0].id;
  await expect(as(c, psy, "update claims set member_id=$2 where id=$1", [claim, m2])).rejects.toThrow(/claim_link_frozen/);
  await as(c, psy, "update claims set preauth_ref='PA2', claim_ref='C2' where id=$1", [claim]); // references stay editable
  // back through rejected -> draft the fields unlock again
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='x'");
  await expect(as(c, psy, "update claims set tariff_code='other' where id=$1", [claim])).rejects.toThrow(/claim_frozen/);
  await setStatus(c, psy, claim, "draft");
  await as(c, psy, "update claims set tariff_code='other', icd10_codes='{F32.9}', claimed_cents=60000 where id=$1", [claim]);
}));

// ---- status machine --------------------------------------------------------------------------------------------------
it("status machine: draft->submitted->accepted|rejected, resubmission, rejected->draft; everything else is rejected", () => withClient(async (c) => {
  const { psy, adm, claim } = await setup(c);
  const bad = (from: string, to: string) => expect(setStatus(c, psy, claim, to), `${from}->${to}`).rejects.toThrow(/invalid_claim_transition/);
  await bad("draft", "accepted"); await bad("draft", "rejected"); await bad("draft", "part_paid"); await bad("draft", "paid");
  await setStatus(c, psy, claim, "submitted");
  const sub1 = (await c.query("select submitted_at from claims where id=$1", [claim])).rows[0].submitted_at;
  expect(sub1).not.toBeNull();
  await bad("submitted", "draft"); await bad("submitted", "part_paid"); await bad("submitted", "paid");
  await setStatus(c, adm, claim, "accepted");
  await bad("accepted", "draft"); await bad("accepted", "rejected"); await bad("accepted", "paid"); await bad("accepted", "part_paid");
  await setStatus(c, psy, claim, "submitted"); // resubmission
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='Missing ICD-10'");
  await bad("rejected", "accepted"); await bad("rejected", "paid"); await bad("rejected", "part_paid");
  await setStatus(c, psy, claim, "draft");
  await setStatus(c, psy, claim, "submitted");
  await expect(setStatus(c, psy, claim, "bogus")).rejects.toThrow(/invalid_claim_transition|check constraint/);
  expect(await cs(c, claim)).toBe("submitted");
}));

it("part_paid and paid are reachable only through record_scheme_remittance", () => withClient(async (c) => {
  const { psy, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  for (const st of ["part_paid", "paid"]) {
    await expect(setStatus(c, psy, claim, st), st).rejects.toThrow(/invalid_claim_transition/);
    await expect(asService(c, () => c.query("update claims set status=$2 where id=$1", [claim, st])), "service " + st).rejects.toThrow(/invalid_claim_transition/);
  }
  await remit(c, psy, claim, 10000, "R1");
  expect(await cs(c, claim)).toBe("part_paid");
  await expect(setStatus(c, psy, claim, "paid")).rejects.toThrow(/invalid_claim_transition/);
  await expect(setStatus(c, psy, claim, "draft")).rejects.toThrow(/invalid_claim_transition/);
  await expect(setStatus(c, psy, claim, "rejected", ", rejection_reason='x'")).rejects.toThrow(/invalid_claim_transition/);
}));

it("rejection needs a reason and creates exactly one task per rejection", () => withClient(async (c) => {
  const { psy, claim, p1 } = await setup(c);
  const tasks = async () => (await c.query("select patient_id, priority from tasks where source='claim_rejected'")).rows;
  await setStatus(c, psy, claim, "submitted");
  await expect(setStatus(c, psy, claim, "rejected")).rejects.toThrow(/rejection_reason_required/);
  await expect(setStatus(c, psy, claim, "rejected", ", rejection_reason='   '")).rejects.toThrow(/rejection_reason_required/);
  expect(await tasks()).toHaveLength(0);
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='Wrong tariff'");
  expect(await tasks()).toEqual([{ patient_id: p1, priority: "high" }]);
  await as(c, psy, "update claims set rejection_reason='Wrong tariff code' where id=$1", [claim]); // editing while rejected: no new task
  await as(c, psy, "update claims set preauth_ref='PA' where id=$1", [claim]);
  expect(await tasks()).toHaveLength(1);
  await setStatus(c, psy, claim, "draft");
  await setStatus(c, psy, claim, "submitted");
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='Again'");
  expect(await tasks()).toHaveLength(2); // a second rejection, a second task
}));

it("claims are never deleted", () => withClient(async (c) => {
  const { psy, adm, claim } = await setup(c);
  for (const u of [psy, adm]) await expect(as(c, u, "delete from claims where id=$1", [claim])).rejects.toThrow(/permission denied/);
  await expect(asService(c, () => c.query("delete from claims where id=$1", [claim]))).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from claims where id=$1", [claim])).rejects.toThrow(/claims cannot be deleted/);
}));

// ---- claim_events ----------------------------------------------------------------------------------------------------
it("claim_events: written by trigger with actor and from/to status; append-only; staff only", () => withClient(async (c) => {
  const { psy, adm, bk, u1, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await setStatus(c, adm, claim, "accepted");
  const ev = (await c.query("select event, from_status, to_status, actor from claim_events where claim_id=$1 order by id", [claim])).rows;
  expect(ev).toEqual([
    { event: "status:draft", from_status: null, to_status: "draft", actor: psy },
    { event: "status:submitted", from_status: "draft", to_status: "submitted", actor: psy },
    { event: "status:accepted", from_status: "submitted", to_status: "accepted", actor: adm }]);
  await as(c, psy, "update claims set preauth_ref='x' where id=$1", [claim]);
  expect((await c.query("select 1 from claim_events where claim_id=$1", [claim])).rowCount).toBe(3); // no status change, no event
  for (const u of [psy, adm]) {
    await expect(as(c, u, "insert into claim_events(claim_id,event) values ($1,'x')", [claim])).rejects.toThrow(/permission denied/);
    await expect(as(c, u, "update claim_events set event='x'")).rejects.toThrow(/permission denied/);
    await expect(as(c, u, "delete from claim_events")).rejects.toThrow(/permission denied/);
  }
  await expect(asService(c, () => c.query("delete from claim_events"))).rejects.toThrow(/permission denied/);
  await expect(c.query("update claim_events set event='x'")).rejects.toThrow(/claim_events is append-only/);
  await expect(c.query("delete from claim_events")).rejects.toThrow(/claim_events is append-only/);
  expect(await count(c, psy, "claim_events")).toBe(3);
  expect(await count(c, adm, "claim_events")).toBe(3);
  expect(await count(c, bk, "claim_events")).toBe(0);
  expect(await count(c, u1, "claim_events")).toBe(0);
}));

// ---- submission / acceptance never move money -----------------------------------------------------------------------
it("submitting or accepting a claim never changes the invoice status or paid amount", () => withClient(async (c) => {
  const { psy, i, claim } = await setup(c);
  await pay(c, psy, i, "eft", 20000, "P");
  expect(await status(c, i)).toBe("part_paid");
  await setStatus(c, psy, claim, "submitted");
  await setStatus(c, psy, claim, "accepted");
  await as(c, psy, "update claims set approved_cents=80000 where id=$1", [claim]);
  expect(await status(c, i)).toBe("part_paid");
  expect(await paid(c, i)).toBe(20000);
  const j = await mkMaInvoice(c, (await c.query("select patient_id from invoices where id=$1", [i])).rows[0].patient_id);
  const c2 = (await as(c, psy, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,80000) returning id", [j.i, j.m])).rows[0].id;
  await setStatus(c, psy, c2, "submitted");
  await setStatus(c, psy, c2, "accepted");
  expect(await status(c, j.i)).toBe("issued");
  expect(await paid(c, j.i)).toBe(0);
}));

// ---- cumulative cap, invoice state ----------------------------------------------------------------------------------
it("claims on one invoice may not add up to more than its scheme portion; rejected claims do not count", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const { i, m } = await mkMaInvoice(c, p1); // scheme portion 80 000
  const mk = async (amt: number) => (await as(c, psy, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,$3) returning id", [i, m, amt])).rows[0].id as string;
  const a = await mk(50000), b = await mk(30000);
  await expect(mk(1)).rejects.toThrow(/claims_exceed_scheme_portion/);
  await expect(as(c, psy, "update claims set claimed_cents=30001 where id=$1", [b])).rejects.toThrow(/claims_exceed_scheme_portion/);
  await setStatus(c, psy, a, "submitted");
  await setStatus(c, psy, a, "rejected", ", rejection_reason='x'");
  const d = await mk(50000); // the rejected sibling no longer counts
  await expect(mk(1)).rejects.toThrow(/claims_exceed_scheme_portion/);
  await expect(setStatus(c, psy, a, "draft")).rejects.toThrow(/claims_exceed_scheme_portion/); // bringing it back would exceed
  await expect(setStatus(c, psy, a, "submitted")).rejects.toThrow(/claims_exceed_scheme_portion/);
  await setStatus(c, psy, d, "submitted");
  await setStatus(c, psy, d, "rejected", ", rejection_reason='y'");
  await setStatus(c, psy, a, "draft"); // room again
  expect(await cs(c, a)).toBe("draft");
}));

it("a claim cannot be updated once its invoice is no longer issued / part_paid", () => withClient(async (c) => {
  const { psy, i, claim } = await setup(c);
  await c.query("update invoices set status='paid' where id=$1", [i]); // owner forces it
  await expect(as(c, psy, "update claims set preauth_ref='x' where id=$1", [claim])).rejects.toThrow(/invoice_not_claimable/);
  await expect(setStatus(c, psy, claim, "submitted")).rejects.toThrow(/invoice_not_claimable/);
}));

it("voiding an invoice is refused while any claim is submitted / accepted / part_paid / paid; a draft or rejected claim does not block", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const mkClaim = async () => {
    const { i, m } = await mkMaInvoice(c, p1);
    return { i, cl: (await as(c, psy, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,1000) returning id", [i, m])).rows[0].id as string };
  };
  for (const st of ["submitted", "accepted"]) {
    const { i, cl } = await mkClaim();
    await setStatus(c, psy, cl, "submitted");
    if (st === "accepted") await setStatus(c, psy, cl, "accepted");
    await expect(as(c, psy, "update invoices set status='void' where id=$1", [i]), st).rejects.toThrow(/invoice_has_open_claims/);
    expect(await status(c, i)).toBe("issued");
  }
  for (const st of ["part_paid", "paid"]) { // claim states only the remittance function sets: the owner stands in for it
    const { i, cl } = await mkClaim();
    await c.query("update claims set status=$2 where id=$1", [cl, st]);
    await expect(c.query("update invoices set status='void' where id=$1", [i]), st).rejects.toThrow(/invoice_has_open_claims/);
  }
  const draft = await mkClaim();
  await as(c, psy, "update invoices set status='void' where id=$1", [draft.i]);
  expect(await status(c, draft.i)).toBe("void");
  const rej = await mkClaim();
  await setStatus(c, psy, rej.cl, "submitted");
  await setStatus(c, psy, rej.cl, "rejected", ", rejection_reason='x'");
  await as(c, psy, "update invoices set status='void' where id=$1", [rej.i]);
  expect(await status(c, rej.i)).toBe("void");
}));

// ---- record_scheme_remittance --------------------------------------------------------------------------------------
it("remittance: partial then full; status of claim and invoice follow; claim_payments rows; patient portion untouched", () => withClient(async (c) => {
  const { psy, i, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await remit(c, psy, claim, 30000, "REM-1");
  expect(await cs(c, claim)).toBe("part_paid");
  expect(await status(c, i)).toBe("part_paid");
  expect((await c.query("select reconciled_at from claims where id=$1", [claim])).rows[0].reconciled_at).not.toBeNull();
  await remit(c, psy, claim, 50000, "REM-2");
  expect(await cs(c, claim)).toBe("paid");
  expect(await paid(c, i)).toBe(80000);
  expect(await status(c, i)).toBe("part_paid"); // the 20 000 patient portion is still owed
  expect((await c.query("select amount_cents from claim_payments where claim_id=$1 order by amount_cents", [claim])).rows.map((r) => r.amount_cents)).toEqual([30000, 50000]);
  expect((await c.query("select method from payments where invoice_id=$1", [i])).rows.map((r) => r.method)).toEqual(["medical_aid", "medical_aid"]);
  await pay(c, psy, i, "eft", 20000, "PAT");
  expect(await status(c, i)).toBe("paid");
  const ev = (await c.query("select event from claim_events where claim_id=$1 order by id", [claim])).rows.map((r) => r.event);
  expect(ev.slice(0, 2)).toEqual(["status:draft", "status:submitted"]);
  expect(ev).toContain("status:part_paid");
  expect(ev).toContain("status:paid");
  expect(ev.filter((e) => e === "remittance")).toHaveLength(2);
}));

it("remittance is idempotent on p_ref: a replay changes nothing (no second claim_payments row, no status change)", () => withClient(async (c) => {
  const { psy, adm, i, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await remit(c, psy, claim, 30000, "REM-1");
  await remit(c, adm, claim, 30000, "REM-1"); // replay, even by someone else
  expect((await c.query("select 1 from claim_payments where claim_id=$1", [claim])).rowCount).toBe(1);
  expect(await paid(c, i)).toBe(30000);
  expect(await cs(c, claim)).toBe("part_paid");
  await remit(c, psy, claim, 50000, "REM-2");
  expect(await cs(c, claim)).toBe("paid");
  await remit(c, psy, claim, 30000, "REM-1"); // replay after the claim is fully paid is still a no-op, not an error
  await remit(c, psy, claim, 50000, "REM-2");
  expect((await c.query("select 1 from claim_payments where claim_id=$1", [claim])).rowCount).toBe(2);
  expect(await paid(c, i)).toBe(80000);
  expect(await cs(c, claim)).toBe("paid");
  expect((await c.query("select 1 from audit_log where action='claim.remittance' and entity_id=$1", [claim])).rowCount).toBe(2);
  // same ref with a different amount is a conflict
  await expect(remit(c, psy, claim, 29999, "REM-1")).rejects.toThrow(/ref_conflict/);
}));

it("remittance ref clashes with another invoice's or claim's payment are ref_conflict", () => withClient(async (c) => {
  const { psy, p1, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  const other = await mkInvoice(c, p1);
  await asService(c, () => c.query("select record_payment($1,'payfast',100,'SHARED',null)", [other]));
  await expect(remit(c, psy, claim, 100, "SHARED")).rejects.toThrow(/ref_conflict/);
  const j = await mkMaInvoice(c, p1);
  const c2 = (await as(c, psy, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,1000) returning id", [j.i, j.m])).rows[0].id;
  await setStatus(c, psy, c2, "submitted");
  await remit(c, psy, claim, 100, "R-X");
  await expect(remit(c, psy, c2, 100, "R-X")).rejects.toThrow(/ref_conflict/);
}));

it("remittance may not exceed the claim; needs a payable claim, a ref, a positive amount; the invoice cannot be overpaid", () => withClient(async (c) => {
  const { psy, i, claim } = await setup(c);
  await expect(remit(c, psy, claim, 1000, "R0")).rejects.toThrow(/claim_not_payable/); // still draft
  await setStatus(c, psy, claim, "submitted");
  await expect(remit(c, psy, claim, 1000, null)).rejects.toThrow(/ref_required/);
  await expect(remit(c, psy, claim, 1000, " ")).rejects.toThrow(/ref_required/);
  await expect(remit(c, psy, claim, 0, "R1")).rejects.toThrow(/invalid_amount/);
  await expect(remit(c, psy, claim, -5, "R1")).rejects.toThrow(/invalid_amount/);
  await expect(remit(c, psy, "00000000-0000-0000-0000-000000000000", 5, "R1")).rejects.toThrow(/unknown_claim/);
  await expect(remit(c, psy, claim, 80001, "R2")).rejects.toThrow(/remittance_exceeds_claim/);
  await remit(c, psy, claim, 50000, "R3");
  await expect(remit(c, psy, claim, 30001, "R4")).rejects.toThrow(/remittance_exceeds_claim/);
  expect(await paid(c, i)).toBe(50000);
  expect(await cs(c, claim)).toBe("part_paid");
  // rejected claims are not payable
  const s2 = await setup(c);
  await setStatus(c, s2.psy, s2.claim, "submitted");
  await setStatus(c, s2.psy, s2.claim, "rejected", ", rejection_reason='no'");
  await expect(remit(c, s2.psy, s2.claim, 100, "R5")).rejects.toThrow(/claim_not_payable/);
}));

it("remittance cannot overpay the invoice (patient already paid); nothing is half-applied", () => withClient(async (c) => {
  const { psy, i, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await pay(c, psy, i, "eft", 30000, "PAT"); // outstanding is now 70 000, claim wants 80 000
  await expect(remit(c, psy, claim, 80000, "R1")).rejects.toThrow(/overpay/);
  expect((await c.query("select 1 from claim_payments")).rowCount).toBe(0);
  expect(await cs(c, claim)).toBe("submitted");
  expect(await paid(c, i)).toBe(30000);
}));

it("remittance: staff only (psychologist, admin, or the service role); audited", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, g, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  for (const [u, who] of [[bk, "bookkeeper"], [assoc, "associate"], [u1, "patient"], [g, "guardian"]] as const)
    await expect(remit(c, u, claim, 100, "R-" + who), who).rejects.toThrow(/forbidden/);
  await remit(c, adm, claim, 100, "R-adm");
  await asService(c, () => c.query("select record_scheme_remittance($1,200,'R-svc')", [claim]));
  const a = (await c.query("select actor_id, role, detail from audit_log where action='claim.remittance' and entity_id=$1 order by id", [claim])).rows;
  expect(a).toHaveLength(2);
  expect(a[0]).toMatchObject({ actor_id: adm, role: "admin" });
  expect(a[0].detail).toMatchObject({ amount: 100, ref: "R-adm" });
  expect((await c.query("select actor from claim_events where claim_id=$1 and event='remittance' order by id", [claim])).rows[0].actor).toBe(adm);
  expect((await c.query("select recorded_by from payments where gateway_ref='R-adm'")).rows[0].recorded_by).toBe(adm);
}));

it("claims_guard binds an untrusted custom role: no paid status, no amount change after submission", () => withClient(async (c) => {
  const { psy, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await c.query("create role app_z login");
  await c.query("grant authenticated to app_z");
  await c.query("set local role app_z");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: psy, role: "authenticated" })]);
  try {
    await expect(c.query("update claims set status='paid' where id=$1", [claim])).rejects.toThrow(/invalid_claim_transition/);
    await expect(c.query("update claims set status='part_paid' where id=$1", [claim])).rejects.toThrow(/invalid_claim_transition/);
    await expect(c.query("update claims set claimed_cents=1 where id=$1", [claim])).rejects.toThrow(/claim_amount_frozen/);
    await expect(c.query("insert into claims(invoice_id,member_id,status) select invoice_id, member_id, 'submitted' from claims")).rejects.toThrow(/claim_must_start_as_draft/);
  } finally { await c.query("reset role"); await c.query("select set_config('request.jwt.claims', '', true)"); }
  expect(await cs(c, claim)).toBe("submitted");
}));

it("claim_payments are append-only and written only by the remittance function", () => withClient(async (c) => {
  const { psy, adm, bk, u1, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await remit(c, psy, claim, 100, "R1");
  for (const u of [psy, adm]) {
    await expect(as(c, u, "insert into claim_payments(claim_id,payment_id,amount_cents) select claim_id,payment_id,1 from claim_payments")).rejects.toThrow(/permission denied/);
    await expect(as(c, u, "update claim_payments set amount_cents=1")).rejects.toThrow(/permission denied/);
    await expect(as(c, u, "delete from claim_payments")).rejects.toThrow(/permission denied/);
  }
  await expect(c.query("update claim_payments set amount_cents=1")).rejects.toThrow(/claim_payments is append-only/);
  await expect(c.query("delete from claim_payments")).rejects.toThrow(/claim_payments is append-only/);
  expect(await count(c, psy, "claim_payments")).toBe(1);
  expect(await count(c, adm, "claim_payments")).toBe(1);
  expect(await count(c, bk, "claim_payments")).toBe(1);
  expect(await count(c, u1, "claim_payments")).toBe(0);
}));

it("one payment can back only one claim_payments row", () => withClient(async (c) => {
  const { psy, p1, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await remit(c, psy, claim, 100, "R1");
  const { i, m } = await mkMaInvoice(c, p1);
  const c2 = (await as(c, psy, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,1000) returning id", [i, m])).rows[0].id;
  await expect(c.query("insert into claim_payments(claim_id,payment_id,amount_cents) select $1, payment_id, 100 from claim_payments", [c2])).rejects.toThrow(/duplicate key/);
  expect((await c.query("select 1 from claim_payments")).rowCount).toBe(1);
}));

// ---- claim_summary, claims, icd10_codes, members: role matrix --------------------------------------------------------
it("claim_summary exposes only safe columns and only to psychologist, admin and bookkeeper", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, u2, g, gOld, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  const cols = (await as(c, bk, "select * from claim_summary")).fields.map((f) => f.name);
  expect(cols).toEqual(["id", "invoice_id", "status", "claimed_cents", "approved_cents", "submitted_at"]);
  const m: [string, string, number][] = [[psy, "psychologist", 1], [adm, "admin", 1], [bk, "bookkeeper", 1], [assoc, "associate", 0],
    [u1, "patient", 0], [u2, "other patient", 0], [g, "guardian", 0], [gOld, "expired guardian", 0]];
  for (const [u, who, n] of m) expect(await count(c, u, "claim_summary"), who).toBe(n);
  // read-only: the view runs as its owner, so write privileges must not exist for anyone
  for (const q of ["update claim_summary set claimed_cents=1", "delete from claim_summary", "insert into claim_summary(id) values (gen_random_uuid())"]) {
    await expect(as(c, bk, q), q).rejects.toThrow(/permission denied/);
    await expect(as(c, psy, q), q).rejects.toThrow(/permission denied/);
  }
  await c.query("set local role anon");
  try { await expect(c.query("select 1 from claim_summary")).rejects.toThrow(/permission denied/); } finally { await c.query("reset role"); }
  expect((await c.query("select claimed_cents from claims where id=$1", [claim])).rows[0].claimed_cents).toBe(80000);
}));

it("claims / claim_events / claim_payments / icd10_codes: bookkeeper and patients read zero rows", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, u2, g, gOld, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await remit(c, psy, claim, 100, "R1");
  const m: [string, string, number, number, number][] = [ // claims, events, icd10
    [psy, "psychologist", 1, 4, 7], [adm, "admin", 1, 4, 7], [bk, "bookkeeper", 0, 0, 0], [assoc, "associate", 0, 0, 0],
    [u1, "patient", 0, 0, 0], [u2, "other patient", 0, 0, 0], [g, "guardian", 0, 0, 0], [gOld, "expired guardian", 0, 0, 0]];
  for (const [u, who, cl, ev, icd] of m) {
    expect(await count(c, u, "claims"), `${who} claims`).toBe(cl);
    expect(await count(c, u, "claim_events"), `${who} events`).toBe(ev);
    expect(await count(c, u, "icd10_codes"), `${who} icd10`).toBe(icd);
  }
  await asUser(c, bk, async () => {
    expect((await c.query("select icd10_codes from claims")).rowCount).toBe(0);
    expect((await c.query("update claims set claimed_cents=1")).rowCount).toBe(0);
  });
  for (const [u, who] of [[bk, "bookkeeper"], [assoc, "associate"], [u1, "patient"], [g, "guardian"]] as const) {
    const i2 = (await c.query("select invoice_id, member_id from claims where id=$1", [claim])).rows[0];
    await expect(as(c, u, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,1)", [i2.invoice_id, i2.member_id]), who).rejects.toThrow(/forbidden/);
    expect((await as(c, u, "update claims set preauth_ref='hack'")).rowCount, `${who} update`).toBe(0);
    await expect(as(c, u, "insert into icd10_codes values ('X99','x')"), who).rejects.toThrow(/permission denied/);
  }
  for (const u of [psy, adm]) await expect(as(c, u, "insert into icd10_codes values ('X99','x')")).rejects.toThrow(/permission denied/);
  expect((await c.query("select 1 from claims where preauth_ref='hack'")).rowCount).toBe(0);
  await c.query("set local role anon");
  try { await expect(c.query("select 1 from claims")).rejects.toThrow(/permission denied/); await expect(c.query("select 1 from icd10_codes")).rejects.toThrow(/permission denied/); }
  finally { await c.query("reset role"); }
}));

it("admin manages claims but cannot write ICD-10 codes (psychologist alone does); admin still reads them", () => withClient(async (c) => {
  const { adm, psy, p1 } = await setup(c);
  const { i, m } = await mkMaInvoice(c, p1);
  await expect(as(c, adm, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,1000,'{F32.9}')", [i, m])).rejects.toThrow(/forbidden/);
  const id = (await as(c, adm, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,1000) returning id", [i, m])).rows[0].id;
  await expect(as(c, adm, "update claims set icd10_codes='{F43.2}' where id=$1", [id])).rejects.toThrow(/forbidden/);
  await as(c, adm, "update claims set claim_ref='C9', tariff_code='86205', claimed_cents=2000 where id=$1", [id]); // everything else is fine
  await as(c, adm, "update claims set icd10_codes='{}' where id=$1", [id]); // unchanged is not a write
  await as(c, psy, "update claims set icd10_codes='{F43.2}' where id=$1", [id]);
  expect((await as(c, adm, "select icd10_codes from claims where id=$1", [id])).rows[0].icd10_codes).toEqual(["F43.2"]);
  await setStatus(c, adm, id, "submitted"); // admin can still work the claim
  expect((await as(c, adm, "select code from icd10_codes where code='F41.1'")).rowCount).toBe(1);
}));

it("claim ICD-10 codes must exist in icd10_codes; approved cannot exceed claimed", () => withClient(async (c) => {
  const { psy, claim, i } = await setup(c);
  await expect(as(c, psy, "update claims set icd10_codes='{F41.1,X00.0}' where id=$1", [claim])).rejects.toThrow(/unknown_icd10/);
  const { i: i2, m: m2 } = await mkMaInvoice(c, (await c.query("select patient_id from invoices where id=$1", [i])).rows[0].patient_id);
  await expect(as(c, psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,1,'{nope}')", [i2, m2])).rejects.toThrow(/unknown_icd10/);
  await as(c, psy, "update claims set icd10_codes='{F41.1,F43.2}' where id=$1", [claim]);
  await expect(as(c, psy, "update claims set approved_cents=80001 where id=$1", [claim])).rejects.toThrow(/check constraint/);
  await as(c, psy, "update claims set approved_cents=80000 where id=$1", [claim]);
}));

it("medical_aid_members: staff write; patient/guardian read own; bookkeeper, associate and others see nothing", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, u2, g, gOld, p1, p2 } = await seed(c);
  const m1 = (await as(c, psy, "insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'A','1') returning id", [p1])).rows[0].id;
  await as(c, adm, "insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'B','2')", [p2]);
  const m: [string, string, number][] = [[psy, "psychologist", 2], [adm, "admin", 2], [bk, "bookkeeper", 0], [assoc, "associate", 0],
    [u1, "patient", 1], [u2, "other patient", 1], [g, "guardian", 1], [gOld, "expired guardian", 0]];
  for (const [u, who, n] of m) expect(await count(c, u, "medical_aid_members"), who).toBe(n);
  for (const [u, who] of [[bk, "bookkeeper"], [assoc, "associate"], [u1, "patient"], [g, "guardian"]] as const) {
    await expect(as(c, u, "insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'Z','9')", [p1]), who).rejects.toThrow(/row-level security/);
    expect((await as(c, u, "update medical_aid_members set scheme='hack'")).rowCount, `${who} update`).toBe(0);
    expect((await as(c, u, "delete from medical_aid_members")).rowCount, `${who} delete`).toBe(0);
  }
  expect((await c.query("select 1 from medical_aid_members where scheme='hack'")).rowCount).toBe(0);
  expect((await as(c, psy, "update medical_aid_members set plan='Classic' where id=$1", [m1])).rowCount).toBe(1);
}));

it("a member cannot be moved to another patient once a claim uses it", () => withClient(async (c) => {
  const { psy, p2, m } = await setup(c);
  await expect(as(c, psy, "update medical_aid_members set patient_id=$2 where id=$1", [m, p2])).rejects.toThrow(/member_in_use/);
  await as(c, psy, "update medical_aid_members set plan='Executive' where id=$1", [m]);
}));
