import type { Client } from "pg";
import { it, expect } from "vitest";
import { withClient, asUser, asService, mkUser } from "./helpers";
import { seed, mkInvoice, status, count, as, pay } from "./billing-helpers";

// ---- brief tests (R7 applied; EFT/cash go through a psychologist session because the DB now ties methods to the caller) ----
async function inv(c: Client, total = 100000) {
  const psy = await mkUser(c, "psychologist"); const bk = await mkUser(c, "bookkeeper");
  const p = (await c.query("insert into patients(first_name,last_name) values ('A','B') returning id")).rows[0].id;
  const i = (await c.query("insert into invoices(patient_id,number,total_cents,patient_portion_cents,status) values ($1,'INV-1',$2,$2,'issued') returning id", [p, total])).rows[0].id;
  return { psy, bk, p, i };
}
it("partial then full payment updates status; duplicate ref is a no-op", () => withClient(async (c) => {
  const { i, psy } = await inv(c);
  await c.query("select record_payment($1,'payfast',40000,'PF-1',null)", [i]);
  expect((await c.query("select status from invoices where id=$1", [i])).rows[0].status).toBe("part_paid");
  await c.query("select record_payment($1,'payfast',40000,'PF-1',null)", [i]); // replay
  expect((await c.query("select invoice_paid_cents($1) v", [i])).rows[0].v).toBe(40000);
  await pay(c, psy, i, "eft", 60000, "EFT-9");
  expect((await c.query("select status from invoices where id=$1", [i])).rows[0].status).toBe("paid");
}));
it("over-payment is rejected", () => withClient(async (c) => {
  const { i, psy } = await inv(c);
  await expect(pay(c, psy, i, "cash", 100001)).rejects.toThrow(/overpay/);
}));
it("claim submission does not change paid state; remittance does and keeps patient portion", () => withClient(async (c) => {
  const { i, p } = await inv(c);
  await c.query("update invoices set scheme_portion_cents=80000, patient_portion_cents=20000 where id=$1", [i]);
  const m = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'Discovery','123') returning id", [p])).rows[0].id;
  const cl = (await c.query("insert into claims(invoice_id,member_id,status,claimed_cents) values ($1,$2,'submitted',80000) returning id", [i, m])).rows[0].id;
  expect((await c.query("select status from invoices where id=$1", [i])).rows[0].status).toBe("issued");
  await c.query("select record_scheme_remittance($1,80000,'REM-1')", [cl]);
  const r = (await c.query("select status from invoices where id=$1", [i])).rows[0].status;
  expect(r).toBe("part_paid");
  expect((await c.query("select status from claims where id=$1", [cl])).rows[0].status).toBe("paid");
}));
it("bookkeeper cannot read ICD-10 codes on claims (R7: zero rows)", () => withClient(async (c) => {
  const { bk, i, p } = await inv(c);
  const m = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'X','1') returning id", [p])).rows[0].id;
  await c.query("insert into claims(invoice_id,member_id,icd10_codes,claimed_cents) values ($1,$2,'{F41.1}',1000)", [i, m]);
  await asUser(c, bk, async () => {
    expect((await c.query("select icd10_codes from claims")).rowCount).toBe(0);
    const ok = await c.query("select id, status, claimed_cents from claim_summary");
    expect(ok.rowCount).toBe(1);
  });
}));

it("setup insert order from the brief works for the owner: issued invoice, portion update, claim inserted as submitted", () => withClient(async (c) => {
  const p = (await c.query("insert into patients(first_name,last_name) values ('A','B') returning id")).rows[0].id;
  const i = (await c.query("insert into invoices(patient_id,number,total_cents,patient_portion_cents,status) values ($1,'INV-1',100000,100000,'issued') returning id", [p])).rows[0].id;
  await c.query("update invoices set scheme_portion_cents=80000, patient_portion_cents=20000 where id=$1", [i]);
  const m = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'Discovery','123') returning id", [p])).rows[0].id;
  const cl = (await c.query("insert into claims(invoice_id,member_id,status,claimed_cents) values ($1,$2,'submitted',80000) returning id", [i, m])).rows[0];
  expect(cl.id).toBeTruthy();
  const s = (await c.query("select submitted_at from claims where id=$1", [cl.id])).rows[0];
  expect(s.submitted_at).not.toBeNull(); // stamped even for a direct insert
  await c.query("insert into payments(invoice_id,method,amount_cents,gateway_ref) values ($1,'eft',100000,'X')", [i]);
  expect(await status(c, i)).toBe("paid"); // direct owner insert still recomputes
}));

// ---- invoice lifecycle ---------------------------------------------------------------------------------------------
const draft = async (c: Client, u: string, p: string) =>
  (await as(c, u, "insert into invoices(patient_id,total_cents,patient_portion_cents) values ($1,100000,100000) returning id", [p])).rows[0].id as string;

it("staff create invoices as draft; any other starting status is rejected", () => withClient(async (c) => {
  const { psy, adm, p1 } = await seed(c);
  for (const u of [psy, adm]) {
    const id = await draft(c, u, p1);
    expect(await status(c, id)).toBe("draft");
    expect((await c.query("select number from invoices where id=$1", [id])).rows[0].number).toMatch(/^INV-\d{5}$/);
  }
  for (const s of ["issued", "part_paid", "paid", "void"])
    await expect(as(c, psy, "insert into invoices(patient_id,total_cents,patient_portion_cents,status) values ($1,1,1,$2)", [p1, s]), s)
      .rejects.toThrow(/invoice_must_start_as_draft/);
  await expect(asService(c, () => c.query("insert into invoices(patient_id,status) values ($1,'issued')", [p1]))).rejects.toThrow(/invoice_must_start_as_draft/);
}));

it("issuing requires portions that add up to the total; self-pay has no scheme portion; medical aid may have no patient portion", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const issue = (id: string) => as(c, psy, "update invoices set status='issued' where id=$1", [id]);
  const id = await draft(c, psy, p1);
  await as(c, psy, "update invoices set patient_portion_cents=99999 where id=$1", [id]);
  await expect(issue(id)).rejects.toThrow(/portions_mismatch/);
  await as(c, psy, "update invoices set patient_portion_cents=50000, scheme_portion_cents=50000 where id=$1", [id]); // payer_type still self
  await expect(issue(id)).rejects.toThrow(/self_pay_has_scheme_portion/);
  await as(c, psy, "update invoices set payer_type='split' where id=$1", [id]);
  await issue(id);
  expect(await status(c, id)).toBe("issued");
  const ma = await draft(c, psy, p1);
  await as(c, psy, "update invoices set payer_type='medical_aid', scheme_portion_cents=100000, patient_portion_cents=0 where id=$1", [ma]);
  await issue(ma);
  expect(await status(c, ma)).toBe("issued");
  // an invoice inserted straight into a non-draft state by the owner is held to the same rule
  await expect(c.query("insert into invoices(patient_id,total_cents,patient_portion_cents,scheme_portion_cents,status) values ($1,100,10,10,'issued')", [p1])).rejects.toThrow(/portions_mismatch/);
}));

it("money fields are frozen once issued; due_date stays editable; draft fields are editable", () => withClient(async (c) => {
  const { psy, p1, p2 } = await seed(c);
  const id = await draft(c, psy, p1);
  await as(c, psy, "update invoices set subtotal_cents=1, discount_cents=1, vat_cents=1, number='ZZ-1', issue_date='2030-01-01' where id=$1", [id]);
  await as(c, psy, "update invoices set status='issued' where id=$1", [id]);
  const sets = [`patient_id='${p2}'`, "appointment_id=gen_random_uuid()", "number='ZZ-2'", "issue_date='2031-01-01'",
    "subtotal_cents=2", "discount_cents=2", "vat_cents=2", "total_cents=2", "scheme_portion_cents=1", "patient_portion_cents=1", "payer_type='split'"];
  for (const s of sets) await expect(as(c, psy, `update invoices set ${s} where id=$1`, [id]), s).rejects.toThrow(/invoice_frozen/);
  const r = await as(c, psy, "update invoices set due_date='2031-02-02' where id=$1", [id]);
  expect(r.rowCount).toBe(1);
  expect((await c.query("select due_date::text d from invoices where id=$1", [id])).rows[0].d).toBe("2031-02-02");
  // the freeze also holds the moment the invoice is voided
  await expect(as(c, psy, "update invoices set status='void', total_cents=5 where id=$1", [id])).rejects.toThrow(/invoice_frozen/);
}));

it("status is controlled: only draft->issued, issued->void, draft->void by hand; paid and part_paid never by UPDATE; void is final", () => withClient(async (c) => {
  const { psy, adm, p1 } = await seed(c);
  const d = await draft(c, psy, p1);
  for (const s of ["part_paid", "paid", "bogus"]) await expect(as(c, psy, "update invoices set status=$2 where id=$1", [d, s]), s).rejects.toThrow(/invalid_invoice_transition|check constraint/);
  await as(c, psy, "update invoices set status='issued' where id=$1", [d]);
  for (const s of ["part_paid", "paid", "draft"]) await expect(as(c, adm, "update invoices set status=$2 where id=$1", [d, s]), s).rejects.toThrow(/invalid_invoice_transition/);
  await expect(asService(c, () => c.query("update invoices set status='paid' where id=$1", [d]))).rejects.toThrow(/invalid_invoice_transition/);
  expect(await status(c, d)).toBe("issued");
  await as(c, psy, "update invoices set status='void' where id=$1", [d]);
  for (const s of ["draft", "issued", "paid"]) await expect(as(c, psy, "update invoices set status=$2 where id=$1", [d, s]), s).rejects.toThrow(/invoice_void_is_final/);
  await expect(c.query("update invoices set status='issued' where id=$1", [d])).rejects.toThrow(/invoice_void_is_final/); // even the owner
  const d2 = await draft(c, adm, p1);
  await as(c, adm, "update invoices set status='void' where id=$1", [d2]); // draft -> void
  expect(await status(c, d2)).toBe("void");
}));

it("void is refused when a succeeded payment exists, and a part-paid invoice cannot be voided by hand", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await pay(c, psy, i, "eft", 1000, "E1");
  expect(await status(c, i)).toBe("part_paid");
  await expect(as(c, psy, "update invoices set status='void' where id=$1", [i])).rejects.toThrow(/invalid_invoice_transition/);
  await c.query("update invoices set status='issued' where id=$1", [i]); // owner forces the state back to prove the payment check itself
  await expect(as(c, psy, "update invoices set status='void' where id=$1", [i])).rejects.toThrow(/invoice_has_payments/);
}));

it("an issued invoice can be voided when it has no payments", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await as(c, psy, "update invoices set status='void' where id=$1", [i]);
  expect(await status(c, i)).toBe("void");
}));

it("invoice id and created_at cannot be rewritten", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const id = await draft(c, psy, p1);
  await expect(as(c, psy, "update invoices set id=gen_random_uuid() where id=$1", [id])).rejects.toThrow(/invoice_frozen/);
  await expect(as(c, psy, "update invoices set created_at='2000-01-01' where id=$1", [id])).rejects.toThrow(/invoice_frozen/);
}));

it("invoice lines: editable on a draft, frozen (insert/update/delete) once the invoice is not a draft", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const id = await draft(c, psy, p1);
  const l = (await as(c, psy, "insert into invoice_lines(invoice_id,description,quantity,unit_cents) values ($1,'Session',1,100000) returning id", [id])).rows[0].id;
  await as(c, psy, "update invoice_lines set quantity=2 where id=$1", [l]);
  await as(c, psy, "update invoices set total_cents=100000 where id=$1", [id]);
  const l2 = (await as(c, psy, "insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'Tmp',5) returning id", [id])).rows[0].id;
  expect((await as(c, psy, "delete from invoice_lines where id=$1", [l2])).rowCount).toBe(1);
  await as(c, psy, "update invoices set status='issued' where id=$1", [id]);
  await expect(as(c, psy, "insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'x',1)", [id])).rejects.toThrow(/invoice_lines_frozen/);
  await expect(as(c, psy, "update invoice_lines set unit_cents=1 where id=$1", [l])).rejects.toThrow(/invoice_lines_frozen/);
  await expect(as(c, psy, "delete from invoice_lines where id=$1", [l])).rejects.toThrow(/invoice_lines_frozen/);
  await expect(c.query("delete from invoice_lines where id=$1", [l])).rejects.toThrow(/invoice_lines_frozen/); // the owner too
  // moving a line from a draft onto an issued invoice is also blocked
  const d = await draft(c, psy, p1);
  const l3 = (await as(c, psy, "insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'y',1) returning id", [d])).rows[0].id;
  await expect(as(c, psy, "update invoice_lines set invoice_id=$2 where id=$1", [l3, id])).rejects.toThrow(/invoice_lines_frozen/);
  // lines on a voided invoice stay frozen
  await as(c, psy, "update invoices set status='void' where id=$1", [d]);
  await expect(as(c, psy, "delete from invoice_lines where id=$1", [l3])).rejects.toThrow(/invoice_lines_frozen/);
}));

it("invoices are never deleted; lines have non-negative money", () => withClient(async (c) => {
  const { psy, adm, p1 } = await seed(c);
  const id = await draft(c, psy, p1);
  for (const u of [psy, adm]) await expect(as(c, u, "delete from invoices where id=$1", [id])).rejects.toThrow(/permission denied/);
  await expect(asService(c, () => c.query("delete from invoices where id=$1", [id]))).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from invoices where id=$1", [id])).rejects.toThrow(/invoices cannot be deleted/);
  await expect(c.query("insert into invoice_lines(invoice_id,description,quantity,unit_cents) values ($1,'x',0,1)", [id])).rejects.toThrow(/check constraint/);
  await expect(c.query("insert into invoice_lines(invoice_id,description,quantity,unit_cents) values ($1,'x',1,-1)", [id])).rejects.toThrow(/check constraint/);
  for (const col of ["subtotal_cents", "discount_cents", "vat_cents", "total_cents", "scheme_portion_cents", "patient_portion_cents"])
    await expect(c.query(`update invoices set ${col}=-1 where id=$1`, [id]), col).rejects.toThrow(/check constraint/);
}));

// ---- role matrix: invoices, invoice_lines ---------------------------------------------------------------------------
it("invoices / invoice_lines read matrix (guardian only while the guardianship is current)", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, u2, p1, g, gOld } = await seed(c);
  const i = await mkInvoice(c, p1);
  const d = await draft(c, psy, p1);
  await c.query("insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'x',1),($1,'y',1)", [d]);
  const m: [string, string, number, number][] = [[psy, "psychologist", 2, 2], [adm, "admin", 2, 2], [bk, "bookkeeper", 2, 2],
    [u1, "patient", 2, 2], [u2, "other patient", 0, 0], [g, "current guardian", 2, 2], [gOld, "expired guardian", 0, 0], [assoc, "associate", 0, 0]];
  expect(i).toBeTruthy();
  for (const [u, who, inv, lines] of m) {
    expect(await count(c, u, "invoices"), `${who} invoices`).toBe(inv);
    expect(await count(c, u, "invoice_lines"), `${who} lines`).toBe(lines);
  }
  await c.query("set local role anon");
  try { await expect(c.query("select 1 from invoices")).rejects.toThrow(/permission denied/); } finally { await c.query("reset role"); }
}));

it("invoices / invoice_lines write matrix: only psychologist and admin write", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, p1, g } = await seed(c);
  const d = await draft(c, psy, p1);
  const ln = (await c.query("insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'x',1) returning id", [d])).rows[0].id;
  await as(c, adm, "insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'adm',1)", [d]);
  for (const [u, who] of [[bk, "bookkeeper"], [u1, "patient"], [g, "guardian"], [assoc, "associate"]] as const) {
    await expect(as(c, u, "insert into invoices(patient_id) values ($1)", [p1]), who).rejects.toThrow(/row-level security/);
    await expect(as(c, u, "insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'n',1)", [d]), who).rejects.toThrow(/row-level security/);
    expect((await as(c, u, "update invoices set due_date='2031-01-01' where id=$1", [d])).rowCount, `${who} update`).toBe(0);
    expect((await as(c, u, "update invoice_lines set quantity=9 where id=$1", [ln])).rowCount, `${who} line update`).toBe(0);
    expect((await as(c, u, "delete from invoice_lines where id=$1", [ln])).rowCount, `${who} line delete`).toBe(0);
  }
  expect((await c.query("select 1 from invoice_lines where id=$1 and quantity=1", [ln])).rowCount).toBe(1);
  expect((await c.query("select 1 from invoices where due_date='2031-01-01'")).rowCount).toBe(0);
}));
