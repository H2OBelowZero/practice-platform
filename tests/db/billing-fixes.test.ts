import { describe, it, expect } from "vitest";
import type { Client } from "pg";
import { withClient } from "./helpers";
import { seed as seedPeople, mkInvoice, as, pay, guardianWith } from "./billing-helpers";

// 0016: issuing checks the lines; billing_totals by patient; read access of patients and guardians to the totals; admin positive paths.
async function base(c: Client) {
  const s = await seedPeople(c);
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('Therapy',50,95000,0) returning id")).rows[0].id as string;
  return { ...s, t };
}
const LINES = JSON.stringify([{ description: "Therapy session", quantity: 1, unit_cents: 95000 }]);
const draft = (c: Client, who: string, patient: string, o: { appt?: string | null; task?: string | null; lines?: string; subtotal?: number; total?: number } = {}) =>
  as(c, who, "select create_invoice_draft($1,$2,$3,'2030-02-01','self',$4,0,0,$5,0,$5,$6::jsonb) id",
    [patient, o.appt ?? null, o.task ?? null, o.subtotal ?? 95000, o.total ?? 95000, o.lines ?? LINES]).then((r) => r.rows[0].id as string);
const issue = (c: Client, who: string, id: string) => as(c, who, "update invoices set status='issued' where id=$1", [id]);

describe("issuing checks that the lines agree with the figures (lines_mismatch)", () => {
  it("a draft whose lines were changed directly cannot be issued until they agree again", () => withClient(async (c) => {
    const { psy, p1 } = await base(c);
    const id = await draft(c, psy, p1);
    await as(c, psy, "update invoice_lines set unit_cents=1 where invoice_id=$1", [id]); // direct write, as PostgREST would
    await expect(issue(c, psy, id)).rejects.toThrow(/lines_mismatch/);
    await as(c, psy, "update invoice_lines set unit_cents=95000 where invoice_id=$1", [id]);
    await issue(c, psy, id);
    expect((await c.query("select status from invoices where id=$1", [id])).rows[0].status).toBe("issued");
  }));

  it("an extra line, a changed subtotal or a changed total each block issuing", () => withClient(async (c) => {
    const { psy, p1 } = await base(c);
    const a = await draft(c, psy, p1);
    await as(c, psy, "insert into invoice_lines(invoice_id,description,quantity,unit_cents) values ($1,'extra',1,500)", [a]);
    await expect(issue(c, psy, a)).rejects.toThrow(/lines_mismatch/);
    const b = await draft(c, psy, p1);
    await as(c, psy, "update invoices set subtotal_cents=90000, total_cents=90000, patient_portion_cents=90000 where id=$1", [b]);
    await expect(issue(c, psy, b)).rejects.toThrow(/lines_mismatch/);
    const d = await draft(c, psy, p1);
    await as(c, psy, "update invoices set total_cents=100000, patient_portion_cents=100000 where id=$1", [d]); // subtotal - discount + vat <> total
    await expect(issue(c, psy, d)).rejects.toThrow(/lines_mismatch/);
  }));

  it("VAT and discount that add up are issued; a draft with no lines at all is left alone", () => withClient(async (c) => {
    const { psy, p1 } = await base(c);
    const id = await as(c, psy, "select create_invoice_draft($1,null,null,'2030-02-01','self',95000,10000,12750,97750,0,97750,$2::jsonb) id", [p1, LINES]).then((r) => r.rows[0].id as string);
    await issue(c, psy, id);
    const bare = (await c.query("insert into invoices(patient_id,total_cents,patient_portion_cents) values ($1,5000,5000) returning id", [p1])).rows[0].id as string;
    await issue(c, psy, bare);
  }));
});

describe("billing_totals by patient, and who may see the totals", () => {
  const totals = (c: Client, who: string, patient: string | null = null) =>
    as(c, who, "select n::int, invoiced_cents::int i, outstanding_cents::int o from billing_totals(null,null,false,null,'2030-03-01',$1)", [patient]).then((r) => r.rows[0]);

  it("the patient filter limits the sums to one patient", () => withClient(async (c) => {
    const { psy, bk, p1, p2 } = await base(c);
    await mkInvoice(c, p1, { total: 100000 }); await mkInvoice(c, p1, { total: 50000 }); await mkInvoice(c, p2, { total: 70000 });
    expect(await totals(c, bk)).toEqual({ n: 3, i: 220000, o: 220000 });
    expect(await totals(c, psy, p1)).toEqual({ n: 2, i: 150000, o: 150000 });
    expect(await totals(c, psy, p2)).toEqual({ n: 1, i: 70000, o: 70000 });
  }));

  it("a patient only aggregates their own issued invoices; an unrelated patient sees nothing", () => withClient(async (c) => {
    const { u1, u2, p1, p2 } = await base(c);
    await mkInvoice(c, p1, { total: 100000 }); await mkInvoice(c, p1, { status: "draft", total: 30000 }); await mkInvoice(c, p2, { total: 70000 });
    expect(await totals(c, u1)).toEqual({ n: 1, i: 100000, o: 100000 });
    expect(await totals(c, u2)).toEqual({ n: 1, i: 70000, o: 70000 });
    expect(await totals(c, u1, p2)).toEqual({ n: 0, i: 0, o: 0 }); // asking for someone else's id gives nothing
    const due = (await as(c, u1, "select due_date::text d, n::int, outstanding_cents::int o from billing_open_by_due_date()")).rows;
    expect(due.reduce((s, r) => s + r.o, 0)).toBe(100000);
  }));

  it("a guardian with pay=true sees the patient's totals; pay=false, no pay key or an expired guardianship sees nothing", () => withClient(async (c) => {
    const { p1 } = await base(c);
    await mkInvoice(c, p1, { total: 100000 });
    const yes = await guardianWith(c, p1, '{"pay":true}'), no = await guardianWith(c, p1, '{"book":true,"pay":false}');
    const none = await guardianWith(c, p1, '{"book":true}'), old = await guardianWith(c, p1, '{"pay":true}', "2000-01-01");
    expect(await totals(c, yes)).toEqual({ n: 1, i: 100000, o: 100000 });
    for (const g of [no, none, old]) expect(await totals(c, g)).toEqual({ n: 0, i: 0, o: 0 });
    expect((await as(c, no, "select count(*)::int n from billing_open_by_due_date()")).rows[0].n).toBe(0);
    expect((await as(c, yes, "select count(*)::int n from billing_open_by_due_date()")).rows[0].n).toBe(1);
  }));
});

describe("admin may do the draft and fee-task work", () => {
  it("admin saves a draft", () => withClient(async (c) => {
    const { psy, adm, p1 } = await base(c);
    const id = await draft(c, psy, p1);
    await as(c, adm, "select save_invoice_draft($1,'2030-03-01','medical_aid',95000,0,0,95000,95000,0,$2::jsonb)", [id, LINES]);
    expect((await c.query("select payer_type, scheme_portion_cents from invoices where id=$1", [id])).rows[0]).toEqual({ payer_type: "medical_aid", scheme_portion_cents: 95000 });
  }));

  it("admin invoices a cancelled appointment through its fee task, which is closed with the invoice", () => withClient(async (c) => {
    const { adm, p1, t } = await base(c);
    await c.query("update practices set late_cancel_fee_cents=35000");
    const a = (await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,now() + interval '2 hours',now() + interval '170 minutes','confirmed') returning id", [p1, t])).rows[0].id as string;
    await as(c, adm, "select cancel_appointment($1,'x',true)", [a]);
    const task = (await c.query("select id from tasks where source='late_cancel_fee' and appointment_id=$1", [a])).rows[0].id as string;
    const fee = JSON.stringify([{ description: "Late cancellation fee", quantity: 1, unit_cents: 35000 }]);
    const id = await draft(c, adm, p1, { appt: a, task, lines: fee, subtotal: 35000, total: 35000 });
    expect((await c.query("select status from tasks where id=$1", [task])).rows[0].status).toBe("done");
    expect((await c.query("select appointment_id from invoices where id=$1", [id])).rows[0].appointment_id).toBe(a);
    await issue(c, adm, id);
    await pay(c, adm, id, "cash", 1000); // and the issued invoice is payable
  }));
});
