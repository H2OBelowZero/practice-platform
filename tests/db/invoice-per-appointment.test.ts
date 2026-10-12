import { describe, it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";
import { seed as seedPeople, mkInvoice, as, pay } from "./billing-helpers";

// 0015: one live invoice per appointment; invoice_balances / billing_totals / billing_open_by_due_date; atomic draft writes.
async function base(c: Client) {
  const s = await seedPeople(c);
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('Therapy',50,95000,0) returning id")).rows[0].id as string;
  const appt = async (patient: string, status = "attended") => (await c.query(
    "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,now() - interval '2 hours',now() - interval '70 minutes',$3) returning id", [patient, t, status])).rows[0].id as string;
  return { ...s, t, appt };
}
const LINES = JSON.stringify([{ description: "Therapy session", quantity: 1, unit_cents: 95000 }]);
const draft = (c: Client, who: string, o: { patient: string; appt?: string | null; task?: string | null; payer?: string; subtotal?: number; discount?: number; vat?: number; total?: number; scheme?: number; pp?: number; lines?: string; due?: string }) =>
  as(c, who, "select create_invoice_draft($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) id", [
    o.patient, o.appt ?? null, o.task ?? null, o.due ?? "2030-02-01", o.payer ?? "self", o.subtotal ?? 95000, o.discount ?? 0, o.vat ?? 0, o.total ?? 95000,
    o.scheme ?? 0, o.pp ?? 95000, o.lines ?? LINES]).then((r) => r.rows[0].id as string);

describe("one live invoice per appointment", () => {
  it("a second non-void invoice for the same appointment is refused; a void one frees it; manual invoices are unrestricted", () => withClient(async (c) => {
    const { p1, appt } = await base(c);
    const a = await appt(p1);
    const first = (await c.query("insert into invoices(patient_id,appointment_id) values ($1,$2) returning id", [p1, a])).rows[0].id as string;
    await expect(c.query("insert into invoices(patient_id,appointment_id) values ($1,$2)", [p1, a])).rejects.toThrow(/invoices_one_live_per_appointment/);
    await c.query("update invoices set status='void' where id=$1", [first]);
    await c.query("insert into invoices(patient_id,appointment_id) values ($1,$2)", [p1, a]); // freed by the void
    await expect(c.query("insert into invoices(patient_id,appointment_id) values ($1,$2)", [p1, a])).rejects.toThrow(/invoices_one_live_per_appointment/);
    await c.query("insert into invoices(patient_id) values ($1)", [p1]);
    await c.query("insert into invoices(patient_id) values ($1)", [p1]); // no appointment: any number
  }));
});

describe("create_invoice_draft", () => {
  it("creates the draft and its lines for an attended appointment, once", () => withClient(async (c) => {
    const { psy, p1, appt } = await base(c);
    const a = await appt(p1);
    const id = await draft(c, psy, { patient: p1, appt: a });
    const inv = (await c.query("select status, total_cents, appointment_id, patient_portion_cents from invoices where id=$1", [id])).rows[0];
    expect(inv).toMatchObject({ status: "draft", total_cents: 95000, appointment_id: a, patient_portion_cents: 95000 });
    expect((await c.query("select description, quantity, unit_cents from invoice_lines where invoice_id=$1", [id])).rows).toEqual([{ description: "Therapy session", quantity: 1, unit_cents: 95000 }]);
    await expect(draft(c, psy, { patient: p1, appt: a })).rejects.toThrow(/invoices_one_live_per_appointment/);
  }));

  it("lines keep the order they were sent in (position), also after a save", () => withClient(async (c) => {
    const { psy, p1 } = await base(c);
    const three = JSON.stringify([{ description: "Z first", quantity: 1, unit_cents: 100 }, { description: "A second", quantity: 1, unit_cents: 100 }, { description: "M third", quantity: 1, unit_cents: 100 }]);
    const id = await draft(c, psy, { patient: p1, lines: three, subtotal: 300, total: 300, pp: 300 });
    const order = async () => (await c.query("select description, position from invoice_lines where invoice_id=$1 order by position", [id])).rows;
    expect(await order()).toEqual([{ description: "Z first", position: 1 }, { description: "A second", position: 2 }, { description: "M third", position: 3 }]);
    await as(c, psy, "select save_invoice_draft($1,'2030-03-01','self',300,0,0,300,0,300,$2::jsonb)", [id, JSON.stringify(JSON.parse(three).reverse())]);
    expect((await order()).map((r) => r.description)).toEqual(["M third", "A second", "Z first"]);
  }));

  it("admin may create too; bookkeeper, patient and guardian may not", () => withClient(async (c) => {
    const { adm, bk, u1, g, p1 } = await base(c);
    await draft(c, adm, { patient: p1 });
    for (const who of [bk, u1, g]) await expect(draft(c, who, { patient: p1 })).rejects.toThrow(/row-level security|permission denied|forbidden/);
  }));

  it("the appointment must belong to the patient and be attended", () => withClient(async (c) => {
    const { psy, p1, p2, appt } = await base(c);
    await expect(draft(c, psy, { patient: p2, appt: await appt(p1) })).rejects.toThrow(/appointment_patient_mismatch/);
    await expect(draft(c, psy, { patient: p1, appt: await appt(p1, "confirmed") })).rejects.toThrow(/appointment_not_billable/);
    await expect(draft(c, psy, { patient: p1, appt: await appt(p1, "no_show") })).rejects.toThrow(/appointment_not_billable/);
    await expect(draft(c, psy, { patient: p1, appt: await appt(p1, "cancelled") })).rejects.toThrow(/appointment_not_billable/);
    await expect(draft(c, psy, { patient: p1, appt: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/unknown_appointment/);
  }));

  it("refuses figures that do not add up, and bad lines (nothing is left behind)", () => withClient(async (c) => {
    const { psy, p1 } = await base(c);
    await expect(draft(c, psy, { patient: p1, subtotal: 90000 })).rejects.toThrow(/totals_mismatch/); // lines sum to 95000
    await expect(draft(c, psy, { patient: p1, total: 94000 })).rejects.toThrow(/totals_mismatch/);
    await expect(draft(c, psy, { patient: p1, pp: 1 })).rejects.toThrow(/totals_mismatch/); // portions must sum to the total
    await expect(draft(c, psy, { patient: p1, discount: 96000, total: 0, pp: 0 })).rejects.toThrow(/totals_mismatch/); // discount above subtotal
    await expect(draft(c, psy, { patient: p1, lines: "[]" })).rejects.toThrow(/lines_required/);
    await expect(draft(c, psy, { patient: p1, lines: JSON.stringify([{ description: " ", quantity: 1, unit_cents: 1 }]) })).rejects.toThrow(/invalid_line/);
    await expect(draft(c, psy, { patient: p1, lines: JSON.stringify([{ description: "x", quantity: 100, unit_cents: 1 }]), subtotal: 100, total: 100, pp: 100 })).rejects.toThrow(/invalid_line/);
    await expect(draft(c, psy, { patient: p1, payer: "bogus" })).rejects.toThrow();
    expect((await c.query("select count(*)::int n from invoices")).rows[0].n).toBe(0);
  }));

  it("VAT and discount figures are accepted when they add up", () => withClient(async (c) => {
    const { psy, p1 } = await base(c);
    const id = await draft(c, psy, { patient: p1, subtotal: 95000, discount: 10000, vat: 12750, total: 97750, pp: 97750 });
    expect((await c.query("select total_cents from invoices where id=$1", [id])).rows[0].total_cents).toBe(97750);
  }));

  describe("late cancellation fee task", () => {
    async function feeCase(c: Client) {
      const b = await base(c);
      await c.query("update practices set late_cancel_fee_cents=35000");
      const a = await b.appt(b.p1, "confirmed");
      await as(c, b.psy, "select cancel_appointment($1,'x',true)", [a]);
      const task = (await c.query("select id from tasks where source='late_cancel_fee' and appointment_id=$1", [a])).rows[0].id as string;
      return { ...b, a, task };
    }
    const fee = JSON.stringify([{ description: "Late cancellation fee", quantity: 1, unit_cents: 35000 }]);
    const F = { subtotal: 35000, total: 35000, pp: 35000, lines: fee };

    it("invoices a cancelled appointment through its open fee task and closes the task in the same transaction", () => withClient(async (c) => {
      const { psy, p1, a, task } = await feeCase(c);
      const id = await draft(c, psy, { patient: p1, appt: a, task, ...F });
      expect((await c.query("select status from tasks where id=$1", [task])).rows[0].status).toBe("done");
      expect((await c.query("select appointment_id from invoices where id=$1", [id])).rows[0].appointment_id).toBe(a);
      await expect(draft(c, psy, { patient: p1, appt: a, task, ...F })).rejects.toThrow(/task_not_open/); // task already done
    }));

    it("a cancelled appointment without the task, a task for another appointment or patient, and a task without an appointment are refused", () => withClient(async (c) => {
      const { psy, p1, p2, a, task, appt } = await feeCase(c);
      await expect(draft(c, psy, { patient: p1, appt: a, ...F })).rejects.toThrow(/appointment_not_billable/);
      const other = await appt(p1);
      await expect(draft(c, psy, { patient: p1, appt: other, task, ...F })).rejects.toThrow(/task_not_open/);
      await expect(draft(c, psy, { patient: p1, task, ...F })).rejects.toThrow(/task_not_open/);
      await expect(draft(c, psy, { patient: p2, appt: a, task, ...F })).rejects.toThrow(/appointment_patient_mismatch/);
      expect((await c.query("select status from tasks where id=$1", [task])).rows[0].status).toBe("open");
    }));

    it("a failure after the task is closed (bad figures) rolls the task back with the call", () => withClient(async (c) => {
      const { psy, p1, a, task } = await feeCase(c);
      await expect(draft(c, psy, { patient: p1, appt: a, task, ...F, total: 1 })).rejects.toThrow(/totals_mismatch/);
      expect((await c.query("select status from tasks where id=$1", [task])).rows[0].status).toBe("open");
    }));
  });
});

describe("save_invoice_draft", () => {
  const save = (c: Client, who: string, id: string, o: { lines?: string; subtotal?: number; total?: number; pp?: number; scheme?: number; payer?: string; vat?: number; discount?: number } = {}) =>
    as(c, who, "select save_invoice_draft($1,'2030-03-01',$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
      [id, o.payer ?? "self", o.subtotal ?? 95000, o.discount ?? 0, o.vat ?? 0, o.total ?? 95000, o.scheme ?? 0, o.pp ?? 95000, o.lines ?? LINES]);

  it("replaces the due date, payer, figures and every line", () => withClient(async (c) => {
    const { psy, p1 } = await base(c);
    const id = await draft(c, psy, { patient: p1 });
    await save(c, psy, id, {
      lines: JSON.stringify([{ description: "A", quantity: 2, unit_cents: 10000 }, { description: "B", quantity: 1, unit_cents: 5000 }]),
      subtotal: 25000, total: 25000, scheme: 25000, pp: 0, payer: "medical_aid" });
    const inv = (await c.query("select due_date::text d, payer_type, total_cents, scheme_portion_cents from invoices where id=$1", [id])).rows[0];
    expect(inv).toEqual({ d: "2030-03-01", payer_type: "medical_aid", total_cents: 25000, scheme_portion_cents: 25000 });
    expect((await c.query("select description from invoice_lines where invoice_id=$1 order by description", [id])).rows.map((r) => r.description)).toEqual(["A", "B"]);
  }));

  it("a failed save leaves the old lines and figures untouched", () => withClient(async (c) => {
    const { psy, p1 } = await base(c);
    const id = await draft(c, psy, { patient: p1 });
    await expect(save(c, psy, id, { total: 5 })).rejects.toThrow(/totals_mismatch/);
    await expect(save(c, psy, id, { lines: "[]" })).rejects.toThrow(/lines_required/);
    expect((await c.query("select count(*)::int n from invoice_lines where invoice_id=$1", [id])).rows[0].n).toBe(1);
    expect((await c.query("select total_cents from invoices where id=$1", [id])).rows[0].total_cents).toBe(95000);
  }));

  it("an issued or void invoice cannot be saved; bookkeeper and patient cannot save a draft", () => withClient(async (c) => {
    const { psy, bk, u1, p1 } = await base(c);
    const id = await draft(c, psy, { patient: p1 });
    await expect(save(c, bk, id)).rejects.toThrow(/invoice_not_draft/); // RLS hides the update from the bookkeeper
    await expect(save(c, u1, id)).rejects.toThrow(/invoice_not_draft/);
    await as(c, psy, "update invoices set status='issued' where id=$1", [id]);
    await expect(save(c, psy, id)).rejects.toThrow(/invoice_not_draft/);
    const issued = await mkInvoice(c, p1, { status: "void" });
    await expect(save(c, psy, issued)).rejects.toThrow(/invoice_not_draft/);
    expect((await c.query("select count(*)::int n from invoice_lines where invoice_id=$1", [id])).rows[0].n).toBe(1);
  }));
});

describe("invoice_balances, billing_totals, billing_open_by_due_date", () => {
  async function world(c: Client) {
    const b = await base(c);
    const o = await mkInvoice(c, b.p1, { total: 100000 });                               // issued, nothing paid
    const part = await mkInvoice(c, b.p1, { total: 100000 });
    await pay(c, b.psy, part, "cash", 30000);                                           // part_paid
    const full = await mkInvoice(c, b.p1, { total: 50000 });
    await pay(c, b.psy, full, "eft", 50000);                                            // paid
    const cred = await mkInvoice(c, b.p2, { total: 80000 });
    await as(c, b.psy, "insert into credit_notes(invoice_id,amount_cents,reason) values ($1,20000,'goodwill')", [cred]);
    const dr = (await c.query("insert into invoices(patient_id,total_cents,patient_portion_cents) values ($1,70000,70000) returning id", [b.p1])).rows[0].id as string; // draft
    const vd = await mkInvoice(c, b.p1, { total: 40000, status: "void" });
    await c.query("update invoices set due_date='2030-01-10' where id=$1", [o]);
    await c.query("update invoices set due_date='2030-01-10' where id=$1", [part]);
    await c.query("update invoices set due_date='2030-02-20' where id=$1", [cred]);
    return { ...b, o, part, full, cred, dr, vd };
  }
  const bal = async (c: Client, who: string, id: string) => (await as(c, who, "select paid_cents, credit_cents, outstanding_cents, status from invoice_balances where id=$1", [id])).rows[0];
  const totals = async (c: Client, who: string, ...a: unknown[]) => (await as(c, who, "select n::int, invoiced_cents::int i, credited_cents::int cr, received_cents::int r, outstanding_cents::int o from billing_totals($1,$2,$3,$4,$5)", a)).rows[0];

  it("per-invoice paid, credit and outstanding (draft, paid and void owe nothing)", () => withClient(async (c) => {
    const w = await world(c);
    expect(await bal(c, w.bk, w.o)).toMatchObject({ paid_cents: 0, credit_cents: 0, outstanding_cents: 100000 });
    expect(await bal(c, w.bk, w.part)).toMatchObject({ paid_cents: 30000, outstanding_cents: 70000, status: "part_paid" });
    expect(await bal(c, w.bk, w.full)).toMatchObject({ paid_cents: 50000, outstanding_cents: 0, status: "paid" });
    expect(await bal(c, w.bk, w.cred)).toMatchObject({ credit_cents: 20000, outstanding_cents: 60000 });
    expect((await bal(c, w.bk, w.dr)).outstanding_cents).toBe(0);
    expect((await bal(c, w.bk, w.vd)).outstanding_cents).toBe(0);
  }));

  it("totals for no filter, a status, a payer type, overdue and a number search", () => withClient(async (c) => {
    const w = await world(c);
    // invoiced = issued + part_paid + paid (100000 + 100000 + 50000 + 80000); outstanding = 100000 + 70000 + 60000
    expect(await totals(c, w.bk, null, null, false, null, "2030-03-01")).toEqual({ n: 6, i: 330000, cr: 20000, r: 80000, o: 230000 });
    expect(await totals(c, w.bk, "part_paid", null, false, null, "2030-03-01")).toEqual({ n: 1, i: 100000, cr: 0, r: 30000, o: 70000 });
    expect(await totals(c, w.bk, "draft", null, false, null, "2030-03-01")).toEqual({ n: 1, i: 0, cr: 0, r: 0, o: 0 });
    expect((await totals(c, w.bk, null, "medical_aid", false, null, "2030-03-01")).n).toBe(0);
    // overdue on 2030-03-01: o, part (due 10 Jan) and cred (due 20 Feb); the paid one and the draft are not
    expect(await totals(c, w.bk, null, null, true, null, "2030-03-01")).toEqual({ n: 3, i: 280000, cr: 20000, r: 30000, o: 230000 });
    expect((await totals(c, w.bk, null, null, true, null, "2030-01-10")).n).toBe(0); // due today is not overdue
    expect((await totals(c, w.bk, null, null, false, "INV-", "2030-03-01")).n).toBe(6);
    expect((await totals(c, w.bk, null, null, false, "%", "2030-03-01")).n).toBe(0); // a wildcard is a literal
    expect((await totals(c, w.bk, null, null, false, "no-such", "2030-03-01")).n).toBe(0);
  }));

  it("open balances by due date", () => withClient(async (c) => {
    const w = await world(c);
    const r = (await as(c, w.bk, "select due_date::text d, n::int, outstanding_cents::int o from billing_open_by_due_date()")).rows;
    expect(r).toEqual([{ d: "2030-01-10", n: 2, o: 170000 }, { d: "2030-02-20", n: 1, o: 60000 }]);
  }));

  it("patients see only their own issued invoices through the view; anon sees nothing and cannot call the functions", () => withClient(async (c) => {
    const w = await world(c);
    const mine = (await as(c, w.u1, "select id from invoice_balances")).rows.map((r) => r.id).sort();
    expect(mine).toEqual([w.o, w.part, w.full, w.vd].sort()); // not the draft, not p2 invoice
    expect((await as(c, w.u2, "select id from invoice_balances")).rows.map((r) => r.id)).toEqual([w.cred]);
    await c.query("set local role anon");
    try {
      await expect(c.query("select * from invoice_balances")).rejects.toThrow(/permission denied/);
      await expect(c.query("select * from billing_totals()")).rejects.toThrow(/permission denied/);
      await expect(c.query("select * from billing_open_by_due_date()")).rejects.toThrow(/permission denied/);
      await expect(c.query("select create_invoice_draft(null,null,null,null,null,0,0,0,0,0,0,'[]')")).rejects.toThrow(/permission denied/);
    } finally { await c.query("reset role"); }
  }));

  it("the view runs as the caller: the bookkeeper sees every invoice, an unrelated authenticated user sees none", () => withClient(async (c) => {
    const w = await world(c);
    expect((await as(c, w.bk, "select count(*)::int n from invoice_balances")).rows[0].n).toBe(6);
    const stranger = await mkUser(c, "patient");
    expect((await asUser(c, stranger, () => c.query("select count(*)::int n from invoice_balances"))).rows[0].n).toBe(0);
  }));
});
