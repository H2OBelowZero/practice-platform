import type { Client } from "pg";
import { it, expect } from "vitest";
import { withClient, asService } from "./helpers";
import { seed, mkInvoice, status, paid, count, as, pay } from "./billing-helpers";

const svc = (c: Client, i: string, amount: number, ref: string | null, by: string | null = null, method = "payfast") =>
  asService(c, () => c.query("select record_payment($1,$2,$3,$4,$5) id", [i, method, amount, ref, by]));

// ---- record_payment: who, which method, which invoice ----------------------------------------------------------------
it("user sessions: only psychologist/admin, only eft/cash/card_machine, recorded_by is the caller and p_by is ignored", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, g, p1, p2 } = await seed(c);
  const i = await mkInvoice(c, p1, { total: 100000 });
  const other = p2; // any uuid
  const id1 = (await as(c, psy, "select record_payment($1,'eft',1000,null,$2) id", [i, other])).rows[0].id;
  const id2 = (await as(c, adm, "select record_payment($1,'card_machine',1000,null,$2) id", [i, other])).rows[0].id;
  await pay(c, psy, i, "cash", 1000);
  expect((await c.query("select recorded_by from payments where id=$1", [id1])).rows[0].recorded_by).toBe(psy);
  expect((await c.query("select recorded_by from payments where id=$1", [id2])).rows[0].recorded_by).toBe(adm);
  for (const m of ["payfast", "medical_aid", "bogus", "EFT"]) await expect(pay(c, psy, i, m, 1000, "R-" + m), m).rejects.toThrow(/invalid_method/);
  for (const [u, who] of [[bk, "bookkeeper"], [assoc, "associate"], [u1, "patient"], [g, "guardian"]] as const)
    await expect(pay(c, u, i, "eft", 1000), who).rejects.toThrow(/forbidden/);
  expect(await paid(c, i)).toBe(3000);
}));

it("service role (PayFast ITN): payfast only, ref required, p_by recorded", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await svc(c, i, 1000, "PF-1", psy);
  expect((await c.query("select method, recorded_by from payments where gateway_ref='PF-1'")).rows[0]).toEqual({ method: "payfast", recorded_by: psy });
  await expect(svc(c, i, 1000, null)).rejects.toThrow(/ref_required/);
  await expect(svc(c, i, 1000, "  ")).rejects.toThrow(/ref_required/);
  for (const m of ["eft", "cash", "card_machine", "medical_aid"]) await expect(svc(c, i, 1000, "PF-" + m, null, m), m).rejects.toThrow(/invalid_method/);
  expect(await paid(c, i)).toBe(1000);
}));

it("function privileges: _record_payment is internal; record_payment is not callable by anon", () => withClient(async (c) => {
  const priv = async (role: string, fn: string) => (await c.query("select has_function_privilege($1, $2, 'execute') ok", [role, fn])).rows[0].ok;
  for (const r of ["public", "anon", "authenticated", "service_role"]) expect(await priv(r, "_record_payment(uuid,text,int,text,uuid)"), r).toBe(false);
  expect(await priv("anon", "record_payment(uuid,text,int,text,uuid)")).toBe(false);
  expect(await priv("authenticated", "record_payment(uuid,text,int,text,uuid)")).toBe(true);
  expect(await priv("service_role", "record_payment(uuid,text,int,text,uuid)")).toBe(true);
  expect(await priv("anon", "record_scheme_remittance(uuid,int,text)")).toBe(false);
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await expect(as(c, psy, "select _record_payment($1,'eft',1000,null,null)", [i])).rejects.toThrow(/permission denied/);
  await expect(asService(c, () => c.query("select _record_payment($1,'payfast',1000,'X',null)", [i]))).rejects.toThrow(/permission denied/);
  await expect(asService(c, () => c.query("select invoice_recompute($1)", [i]))).rejects.toThrow(/permission denied/);
}));

it("amount must be positive; unknown invoice is rejected", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  for (const a of [0, -5]) await expect(pay(c, psy, i, "eft", a), String(a)).rejects.toThrow(/invalid_amount/);
  await expect(as(c, psy, "select record_payment($1,'eft',null,null,null)", [i])).rejects.toThrow(/invalid_amount/);
  await expect(pay(c, psy, "00000000-0000-0000-0000-000000000000", "eft", 5)).rejects.toThrow(/unknown_invoice/);
}));

it("payable only when issued or part_paid", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  for (const s of ["draft", "void"]) {
    const i = await mkInvoice(c, p1, { status: s });
    await expect(pay(c, psy, i, "eft", 1000), s).rejects.toThrow(/invoice_not_payable/);
    await expect(svc(c, i, 1000, "PF-" + s), s).rejects.toThrow(/invoice_not_payable/);
  }
  const i = await mkInvoice(c, p1, { total: 1000 });
  await pay(c, psy, i, "eft", 1000);
  expect(await status(c, i)).toBe("paid");
  await expect(pay(c, psy, i, "eft", 1)).rejects.toThrow(/invoice_not_payable/);
  // a direct owner insert is held to the same rule by the trigger
  await expect(c.query("insert into payments(invoice_id,method,amount_cents) values ($1,'eft',1)", [i])).rejects.toThrow(/invoice_not_payable/);
  const d = await mkInvoice(c, p1, { status: "draft" });
  await expect(c.query("insert into payments(invoice_id,method,amount_cents) values ($1,'eft',1)", [d])).rejects.toThrow(/invoice_not_payable/);
}));

it("two sequential payments summing over the total: the second is refused and the first stands", () => withClient(async (c) => {
  // The harness is single-connection, so the race itself cannot be tested. The guard serialises payers by locking the invoice
  // row (select ... for update) before it sums, so the second of two concurrent payments waits and then sees the first.
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await pay(c, psy, i, "eft", 60000, "A");
  await expect(pay(c, psy, i, "eft", 60000, "B")).rejects.toThrow(/overpay/);
  expect(await paid(c, i)).toBe(60000);
  expect(await status(c, i)).toBe("part_paid");
  await pay(c, psy, i, "eft", 40000, "C"); // exactly the outstanding amount is fine
  expect(await status(c, i)).toBe("paid");
}));

// ---- idempotency ----------------------------------------------------------------------------------------------------
it("same ref: same invoice and amount returns the existing id; anything else is ref_conflict", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1), j = await mkInvoice(c, p1);
  const a = (await svc(c, i, 4000, "PF-9")).rows[0].id;
  expect((await svc(c, i, 4000, "PF-9")).rows[0].id).toBe(a);
  expect((await svc(c, i, 4000, "PF-9", psy)).rows[0].id).toBe(a);
  expect((await c.query("select 1 from payments where gateway_ref='PF-9'")).rowCount).toBe(1);
  await expect(svc(c, i, 4001, "PF-9")).rejects.toThrow(/ref_conflict/);
  await expect(svc(c, j, 4000, "PF-9")).rejects.toThrow(/ref_conflict/);
  await expect(pay(c, psy, j, "eft", 4000, "PF-9")).rejects.toThrow(/ref_conflict/);
  expect((await pay(c, psy, i, "eft", 4000, "PF-9")).rows[0].id).toBe(a); // user sessions get the same idempotency
  expect(await paid(c, i)).toBe(4000);
  // a replay after the invoice became paid is still a no-op, not invoice_not_payable
  const k = await mkInvoice(c, p1, { total: 500 });
  const first = (await svc(c, k, 500, "PF-K")).rows[0].id;
  expect(await status(c, k)).toBe("paid");
  expect((await svc(c, k, 500, "PF-K")).rows[0].id).toBe(first);
}));

// ---- append-only ----------------------------------------------------------------------------------------------------
it("payments are append-only for everyone, including the owner; rows come only from the functions", () => withClient(async (c) => {
  const { psy, adm, bk, u1, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  const id = (await pay(c, psy, i, "eft", 1000, "A")).rows[0].id;
  for (const u of [psy, adm, bk, u1]) {
    await expect(as(c, u, "insert into payments(invoice_id,method,amount_cents) values ($1,'eft',1)", [i])).rejects.toThrow(/permission denied/);
    await expect(as(c, u, "update payments set amount_cents=1 where id=$1", [id])).rejects.toThrow(/permission denied/);
    await expect(as(c, u, "delete from payments where id=$1", [id])).rejects.toThrow(/permission denied/);
  }
  for (const q of ["insert into payments(invoice_id,method,amount_cents) values ($1,'payfast',1)", "update payments set amount_cents=1 where invoice_id=$1", "delete from payments where invoice_id=$1"])
    await expect(asService(c, () => c.query(q, [i])), q).rejects.toThrow(/permission denied/);
  await expect(c.query("update payments set amount_cents=1 where id=$1", [id])).rejects.toThrow(/payments is append-only/);
  await expect(c.query("delete from payments where id=$1", [id])).rejects.toThrow(/payments is append-only/);
  expect(await paid(c, i)).toBe(1000);
}));

it("each recorded payment is audited; a replay is not audited twice", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  const id = (await pay(c, psy, i, "eft", 1500, "AUD")).rows[0].id;
  await pay(c, psy, i, "eft", 1500, "AUD");
  const rows = (await c.query("select actor_id, role, entity, detail from audit_log where action='payment.record' and entity_id=$1", [id])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor_id: psy, role: "psychologist", entity: "payments" });
  expect(rows[0].detail).toMatchObject({ method: "eft", amount: 1500, invoice_id: i });
}));

it("payments read matrix: staff and bookkeeper see them, a patient/guardian only their own invoice's", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, u2, g, gOld, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await pay(c, psy, i, "eft", 1000);
  const m: [string, string, number][] = [[psy, "psychologist", 1], [adm, "admin", 1], [bk, "bookkeeper", 1], [u1, "patient", 1], [u2, "other patient", 0], [g, "guardian", 1], [gOld, "expired guardian", 0], [assoc, "associate", 0]];
  for (const [u, who, n] of m) expect(await count(c, u, "payments"), who).toBe(n);
}));

// ---- credit notes & status recompute ---------------------------------------------------------------------------------
const credit = (c: Client, u: string, i: string, amount: number, reason = "r") =>
  as(c, u, "insert into credit_notes(invoice_id,amount_cents,reason) values ($1,$2,$3) returning id", [i, amount, reason]);

it("credit notes: psychologist only; created_by is forced to the caller; audited", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, g, p1, p2 } = await seed(c);
  const i = await mkInvoice(c, p1);
  for (const [u, who] of [[adm, "admin"], [bk, "bookkeeper"], [assoc, "associate"], [u1, "patient"], [g, "guardian"]] as const)
    await expect(credit(c, u, i, 100), who).rejects.toThrow(/row-level security/);
  await expect(asService(c, () => c.query("insert into credit_notes(invoice_id,amount_cents,reason) values ($1,100,'r')", [i]))).rejects.toThrow(/permission denied/);
  const id = (await as(c, psy, "insert into credit_notes(invoice_id,amount_cents,reason,created_by) values ($1,100,'goodwill',$2) returning id", [i, p2])).rows[0].id;
  expect((await c.query("select created_by from credit_notes where id=$1", [id])).rows[0].created_by).toBe(psy);
  const a = (await c.query("select actor_id, role, detail from audit_log where action='credit_note.create' and entity_id=$1", [id])).rows;
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ actor_id: psy, role: "psychologist" });
  expect(a[0].detail).toMatchObject({ invoice_id: i, amount: 100, reason: "goodwill" });
  await expect(credit(c, psy, i, 0)).rejects.toThrow(/check constraint/);
  await expect(credit(c, psy, i, 100, "  ")).rejects.toThrow(/reason_required/);
}));

it("credit notes are append-only (privileges revoked and trigger for the owner)", () => withClient(async (c) => {
  const { psy, adm, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  const id = (await credit(c, psy, i, 100)).rows[0].id;
  for (const u of [psy, adm]) {
    await expect(as(c, u, "update credit_notes set amount_cents=1 where id=$1", [id])).rejects.toThrow(/permission denied/);
    await expect(as(c, u, "delete from credit_notes where id=$1", [id])).rejects.toThrow(/permission denied/);
  }
  await expect(asService(c, () => c.query("delete from credit_notes where id=$1", [id]))).rejects.toThrow(/permission denied/);
  await expect(c.query("update credit_notes set amount_cents=1 where id=$1", [id])).rejects.toThrow(/credit_notes is append-only/);
  await expect(c.query("delete from credit_notes where id=$1", [id])).rejects.toThrow(/credit_notes is append-only/);
}));

it("credit notes only on issued / part_paid invoices", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  for (const s of ["draft", "void"]) await expect(credit(c, psy, await mkInvoice(c, p1, { status: s }), 100), s).rejects.toThrow(/invoice_not_creditable/);
  const paidInv = await mkInvoice(c, p1, { total: 1000 });
  await pay(c, psy, paidInv, "eft", 1000);
  await expect(credit(c, psy, paidInv, 1)).rejects.toThrow(/invoice_not_creditable/);
  const part = await mkInvoice(c, p1);
  await pay(c, psy, part, "eft", 1000);
  await credit(c, psy, part, 500);
  expect(await status(c, part)).toBe("part_paid");
}));

it("credit may not exceed the outstanding amount (credits + paid + new <= total)", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await pay(c, psy, i, "eft", 30000, "A");
  await credit(c, psy, i, 20000);
  await expect(credit(c, psy, i, 50001)).rejects.toThrow(/credit_exceeds_outstanding/);
  await credit(c, psy, i, 50000); // exactly the outstanding amount
  expect(await status(c, i)).toBe("paid");
  await expect(credit(c, psy, i, 1)).rejects.toThrow(/invoice_not_creditable/);
}));

it("a payment may not exceed what is left after credit notes", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await credit(c, psy, i, 30000);
  await expect(pay(c, psy, i, "eft", 70001)).rejects.toThrow(/overpay/);
  await pay(c, psy, i, "eft", 70000);
  expect(await status(c, i)).toBe("paid");
}));

it("status recompute: partial credit stays issued; full credit with no payments voids; credit that settles a part-paid invoice marks it paid", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const a = await mkInvoice(c, p1);
  await credit(c, psy, a, 40000);
  expect(await status(c, a)).toBe("issued");
  await credit(c, psy, a, 60000);
  expect(await status(c, a)).toBe("void");
  await expect(pay(c, psy, a, "eft", 1)).rejects.toThrow(/invoice_not_payable/);
  await expect(c.query("update invoices set status='issued' where id=$1", [a])).rejects.toThrow(/invoice_void_is_final/);
  const b = await mkInvoice(c, p1);
  await pay(c, psy, b, "eft", 40000, "B1");
  expect(await status(c, b)).toBe("part_paid");
  await credit(c, psy, b, 60000);
  expect(await status(c, b)).toBe("paid");
  const d = await mkInvoice(c, p1); // credit first, then the rest is paid
  await credit(c, psy, d, 25000);
  await pay(c, psy, d, "eft", 74999);
  expect(await status(c, d)).toBe("part_paid");
  await pay(c, psy, d, "cash", 1);
  expect(await status(c, d)).toBe("paid");
  const e = await mkInvoice(c, p1); // untouched stays issued
  expect(await status(c, e)).toBe("issued");
}));

it("credit notes read matrix: staff and bookkeeper, own patient/guardian; nobody else", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, u2, g, gOld, p1 } = await seed(c);
  const i = await mkInvoice(c, p1);
  await credit(c, psy, i, 100);
  const m: [string, string, number][] = [[psy, "psychologist", 1], [adm, "admin", 1], [bk, "bookkeeper", 1], [u1, "patient", 1], [u2, "other patient", 0], [g, "guardian", 1], [gOld, "expired guardian", 0], [assoc, "associate", 0]];
  for (const [u, who, n] of m) expect(await count(c, u, "credit_notes"), who).toBe(n);
  await c.query("set local role anon");
  try { await expect(c.query("select 1 from credit_notes")).rejects.toThrow(/permission denied/); await expect(c.query("select 1 from payments")).rejects.toThrow(/permission denied/); }
  finally { await c.query("reset role"); }
}));
