import { it, expect, describe } from "vitest";
import type { Client } from "pg";
import { withClient } from "./helpers";
import { seed, mkInvoice, as, pay, count } from "./billing-helpers";

// 0017 (R40): credit notes carry a portion; caps per portion; invoice_balances exposes the two credit sums; practices.payment_instructions.
const credit = (c: Client, u: string, i: string, amount: number, portion: string | null, reason = "r") =>
  as(c, u, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,$2,$3,$4) returning id", [i, amount, reason, portion]);
/** money the scheme paid: a medical_aid payment (inserted by the owner like record_scheme_remittance does; payments_guard still runs) */
const remit = (c: Client, i: string, amount: number, ref: string) =>
  c.query("insert into payments(invoice_id,method,gateway_ref,amount_cents) values ($1,'medical_aid',$2,$3)", [i, ref, amount]);
/** split invoice R1000: scheme 700, patient 300 */
const split = (c: Client, p: string) => mkInvoice(c, p, { total: 100000, scheme: 70000, payer: "split" });

describe("the portion column", () => {
  it("is required (no default), checked, and existing-row style data reads back as given", () => withClient(async (c) => {
    const col = (await c.query("select is_nullable, column_default, data_type from information_schema.columns where table_name='credit_notes' and column_name='portion'")).rows[0];
    expect(col).toEqual({ is_nullable: "NO", column_default: null, data_type: "text" });
    const { psy, p1 } = await seed(c);
    const i = await mkInvoice(c, p1);
    await expect(credit(c, psy, i, 100, null)).rejects.toThrow(/portion_required/);
    await expect(credit(c, psy, i, 100, "both")).rejects.toThrow(/portion_required/);
    await expect(as(c, psy, "insert into credit_notes(invoice_id,amount_cents,reason) values ($1,100,'r')", [i])).rejects.toThrow(/portion_required/);
    await expect(c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,100,'r','both')", [i])).rejects.toThrow(/portion_required/); // the owner path too
    expect(await count(c, psy, "credit_notes")).toBe(0);
  }));

  it("the portion is audited with the credit note", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const id = (await credit(c, psy, await split(c, p1), 5000, "scheme", "shortfall")).rows[0].id;
    const a = (await c.query("select detail from audit_log where action='credit_note.create' and entity_id=$1", [id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].detail).toMatchObject({ amount: 5000, portion: "scheme", reason: "shortfall" });
  }));
});

describe("self-pay invoices", () => {
  it("take 'patient' credits only", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await mkInvoice(c, p1);
    await expect(credit(c, psy, i, 100, "scheme")).rejects.toThrow(/portion_not_allowed/);
    await credit(c, psy, i, 100, "patient");
    expect((await c.query("select portion from credit_notes where invoice_id=$1", [i])).rows).toEqual([{ portion: "patient" }]);
  }));

  it("the overall cap still applies and is reported first", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await mkInvoice(c, p1);
    await pay(c, psy, i, "eft", 30000, "A");
    await expect(credit(c, psy, i, 70001, "patient")).rejects.toThrow(/credit_exceeds_outstanding/);
    await credit(c, psy, i, 70000, "patient");
  }));
});

describe("medical aid invoices (patient portion 0)", () => {
  it("scheme credits up to the portion; patient credits are always refused", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await mkInvoice(c, p1, { total: 100000, scheme: 100000, payer: "medical_aid" });
    await expect(credit(c, psy, i, 1, "patient")).rejects.toThrow(/credit_exceeds_patient_portion/);
    await remit(c, i, 60000, "REM-1");
    await expect(credit(c, psy, i, 40001, "scheme")).rejects.toThrow(/credit_exceeds_outstanding/); // 60000 + 40001 > total: the overall cap first
    await credit(c, psy, i, 40000, "scheme");
  }));
});

describe("split invoices R1000 (scheme 700, patient 300)", () => {
  it("scheme credit: no more than the scheme still owes (scheme portion - remitted - earlier scheme credits)", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await split(c, p1);
    await remit(c, i, 50000, "REM-1");
    await expect(credit(c, psy, i, 20001, "scheme")).rejects.toThrow(/credit_exceeds_scheme_portion/);
    await credit(c, psy, i, 12000, "scheme");
    await expect(credit(c, psy, i, 8001, "scheme")).rejects.toThrow(/credit_exceeds_scheme_portion/); // 20000 - 12000 left
    await credit(c, psy, i, 8000, "scheme");
    await expect(credit(c, psy, i, 1, "scheme")).rejects.toThrow(/credit_exceeds_scheme_portion/);
  }));

  it("the patient's own payments do not use up the scheme portion, nor remittances the patient portion", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await split(c, p1);
    await pay(c, psy, i, "eft", 30000, "E1");   // the patient pays their whole portion
    await credit(c, psy, i, 70000, "scheme");     // the scheme side is still fully open: write it all off
    const j = await split(c, p1);
    await remit(c, j, 70000, "REM-2");
    await credit(c, psy, j, 30000, "patient");    // the patient side is still fully open
  }));

  it("patient credit: no more than the patient still owes (patient portion - own payments - earlier patient credits)", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await split(c, p1);
    await remit(c, i, 50000, "REM-1");
    await expect(credit(c, psy, i, 30001, "patient")).rejects.toThrow(/credit_exceeds_patient_portion/);
    await pay(c, psy, i, "cash", 10000);
    await expect(credit(c, psy, i, 20001, "patient")).rejects.toThrow(/credit_exceeds_patient_portion/);
    await credit(c, psy, i, 15000, "patient");
    await expect(credit(c, psy, i, 5001, "patient")).rejects.toThrow(/credit_exceeds_patient_portion/);
    await credit(c, psy, i, 5000, "patient");
  }));

  it("payfast and card payments count as the patient's own; an over-payment on the patient side leaves nothing to credit but the scheme side stays open", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await split(c, p1);
    await pay(c, psy, i, "card_machine", 35000, "C1"); // R50 more than the patient portion
    await expect(credit(c, psy, i, 1, "patient")).rejects.toThrow(/credit_exceeds_patient_portion/);
    await credit(c, psy, i, 65000, "scheme");
  }));

  it("the R40 scenario: scheme remits 500, then a R200 scheme write-off; or a R200 patient credit instead", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const a = await split(c, p1);
    await remit(c, a, 50000, "REM-A");
    await credit(c, psy, a, 20000, "scheme");
    expect((await as(c, psy, "select outstanding_cents, scheme_credit_cents, patient_credit_cents from invoice_balances where id=$1", [a])).rows[0])
      .toEqual({ outstanding_cents: 30000, scheme_credit_cents: 20000, patient_credit_cents: 0 });
    const b = await split(c, p1);
    await remit(c, b, 50000, "REM-B");
    await credit(c, psy, b, 20000, "patient"); // accepted (the patient portion is R300) ...
    expect((await as(c, psy, "select outstanding_cents, scheme_credit_cents, patient_credit_cents from invoice_balances where id=$1", [b])).rows[0])
      .toEqual({ outstanding_cents: 30000, scheme_credit_cents: 0, patient_credit_cents: 20000 }); // ... but the scheme still owes R200 (the app refuses Pay now)
  }));

  it("a credit that settles everything still owed on the scheme side and the patient side together closes the invoice", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await split(c, p1);
    await remit(c, i, 50000, "REM-1");
    await pay(c, psy, i, "eft", 20000, "E1");
    await credit(c, psy, i, 20000, "scheme");
    await credit(c, psy, i, 10000, "patient");
    expect((await c.query("select status from invoices where id=$1", [i])).rows[0].status).toBe("paid");
  }));
});

describe("who may add a credit note, either portion", () => {
  it("psychologist only (admin, bookkeeper, associate, patient, guardian are forbidden for both portions)", () => withClient(async (c) => {
    const { psy, adm, bk, assoc, u1, g, p1 } = await seed(c);
    const i = await split(c, p1);
    for (const [u, who] of [[adm, "admin"], [bk, "bookkeeper"], [assoc, "associate"], [u1, "patient"], [g, "guardian"]] as const)
      for (const portion of ["scheme", "patient"]) await expect(credit(c, u, i, 100, portion), `${who} ${portion}`).rejects.toThrow(/forbidden/);
    expect(await count(c, psy, "credit_notes")).toBe(0);
    await credit(c, psy, i, 100, "scheme");
    await credit(c, psy, i, 100, "patient");
    expect(await count(c, psy, "credit_notes")).toBe(2);
  }));

  it("the portion cannot be changed afterwards (append-only)", () => withClient(async (c) => {
    const { psy, adm, p1 } = await seed(c);
    const id = (await credit(c, psy, await split(c, p1), 100, "scheme")).rows[0].id;
    for (const u of [psy, adm]) await expect(as(c, u, "update credit_notes set portion='patient' where id=$1", [id])).rejects.toThrow(/permission denied/);
    await expect(c.query("update credit_notes set portion='patient' where id=$1", [id])).rejects.toThrow(/credit_notes is append-only/);
  }));
});

describe("invoice_balances", () => {
  it("is still a security_invoker view with the same grants, and shows the two credit sums to the patient and a guardian who may pay, not to others", () => withClient(async (c) => {
    const { psy, bk, u1, u2, g, gOld, p1 } = await seed(c);
    const opts = (await c.query("select reloptions from pg_class where relname='invoice_balances'")).rows[0].reloptions as string[];
    expect(opts).toContain("security_invoker=true");
    const grants = (await c.query("select grantee, privilege_type from information_schema.role_table_grants where table_name='invoice_balances' order by 1,2")).rows;
    expect(grants.filter((r) => r.grantee === "anon")).toEqual([]);
    expect(grants).toEqual(expect.arrayContaining([{ grantee: "authenticated", privilege_type: "SELECT" }, { grantee: "service_role", privilege_type: "SELECT" }]));

    const i = await split(c, p1);
    await remit(c, i, 50000, "REM-1");
    await credit(c, psy, i, 15000, "scheme");
    await credit(c, psy, i, 5000, "patient");
    const row = (u: string) => as(c, u, "select credit_cents, scheme_credit_cents, patient_credit_cents, paid_cents, outstanding_cents from invoice_balances where id=$1", [i]);
    const expected = { credit_cents: 20000, scheme_credit_cents: 15000, patient_credit_cents: 5000, paid_cents: 50000, outstanding_cents: 30000 };
    for (const u of [psy, bk, u1, g]) expect((await row(u)).rows, u).toEqual([expected]);
    for (const u of [u2, gOld]) expect((await row(u)).rows, u).toEqual([]);
    await expect(c.query("select 1 from invoice_balances")).resolves.toBeTruthy(); // owner can read
  }));

  it("an invoice with no credit notes reports zeros, not nulls", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await mkInvoice(c, p1);
    expect((await as(c, psy, "select credit_cents, scheme_credit_cents, patient_credit_cents from invoice_balances where id=$1", [i])).rows).toEqual([{ credit_cents: 0, scheme_credit_cents: 0, patient_credit_cents: 0 }]);
  }));
});

describe("practices.payment_instructions", () => {
  it("defaults to a neutral sentence, is readable by a patient, and only the psychologist can change it", () => withClient(async (c) => {
    const { psy, adm, bk, u1, g } = await seed(c);
    const text = (u: string) => as(c, u, "select payment_instructions from practices").then((r) => r.rows.map((x) => x.payment_instructions));
    for (const u of [psy, adm, bk, u1, g]) expect(await text(u)).toEqual(["Please contact the practice for EFT details."]);
    for (const u of [adm, bk, u1, g]) { const r = await as(c, u, "update practices set payment_instructions='Pay me' returning id"); expect(r.rowCount, u).toBe(0); }
    expect((await as(c, psy, "update practices set payment_instructions='Bank: Example, acc 123' returning id")).rowCount).toBe(1);
    expect(await text(u1)).toEqual(["Bank: Example, acc 123"]);
    await expect(c.query("update practices set payment_instructions=null")).rejects.toThrow(/null value/);
  }));
});
