import { it, expect, describe } from "vitest";
import type { Client } from "pg";
import { withClient } from "./helpers";
import { seed, mkInvoice, as, pay, guardianWith } from "./billing-helpers";
import { buildPortalInvoices, summarise } from "@/lib/portal/payments";

// The exact reads the portal Payments pages make (lib/portal/load.ts), run as patient and guardian sessions: RLS is the only thing between a
// signed-in user and other people's money, and the portal's pay-now decision is computed from these rows.
const INVOICE_COLS = "id, number, patient_id, status, payer_type, issue_date, due_date, total_cents, scheme_portion_cents, patient_portion_cents, outstanding_cents";
const invoices = (c: Client, u: string) => as(c, u, `select ${INVOICE_COLS} from invoice_balances where status <> 'draft' order by issue_date desc`).then((r) => r.rows);
const payments = (c: Client, u: string) => as(c, u, "select id, invoice_id, method, amount_cents, received_on from payments where status = 'succeeded'").then((r) => r.rows);
const credits = (c: Client, u: string) => as(c, u, "select invoice_id, portion, amount_cents from credit_notes").then((r) => r.rows);
const people = (c: Client, u: string) => as(c, u, "select id, first_name, user_id from patients").then((r) => r.rows);
const remit = (c: Client, i: string, amount: number, ref: string) => c.query("insert into payments(invoice_id,method,gateway_ref,amount_cents) values ($1,'medical_aid',$2,$3)", [i, ref, amount]);
describe("who can read which invoices", () => {
  it("a patient reads only their own issued invoices (no drafts, nobody else's) in invoice_balances, payments and credit notes", () => withClient(async (c) => {
    const { psy, u1, u2, p1, p2 } = await seed(c);
    const mine = await mkInvoice(c, p1), draft = await mkInvoice(c, p1, { status: "draft" }), theirs = await mkInvoice(c, p2);
    await pay(c, psy, mine, "eft", 10000);
    await pay(c, psy, theirs, "eft", 5000);
    await as(c, psy, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,1000,'x','patient')", [mine]);
    expect((await invoices(c, u1)).map((r) => r.id)).toEqual([mine]);
    expect((await payments(c, u1)).map((r) => r.invoice_id)).toEqual([mine]);
    expect((await credits(c, u1)).map((r) => r.invoice_id)).toEqual([mine]);
    expect((await invoices(c, u2)).map((r) => r.id)).toEqual([theirs]);
    expect((await as(c, u1, "select 1 from invoice_balances where id=$1", [draft])).rowCount).toBe(0);
    expect((await as(c, u1, "select 1 from invoices where id=$1", [theirs])).rowCount).toBe(0); // the detail page's own read: 404
  }));

  it("a guardian sees the child's invoices only with permissions.pay, and only while the guardianship is current", async () => {
    await withClient(async (c) => {
      const { psy, p1 } = await seed(c);
      const inv = await mkInvoice(c, p1);
      await pay(c, psy, inv, "eft", 100);
      const yes = await guardianWith(c, p1, '{"pay": true}');
      const no = await guardianWith(c, p1, '{"pay": false, "book": true}');
      const missing = await guardianWith(c, p1, "{}");
      const expired = await guardianWith(c, p1, '{"pay": true}', "2000-01-01");
      expect((await invoices(c, yes)).map((r) => r.id)).toEqual([inv]);
      expect((await payments(c, yes)).length).toBe(1);
      expect((await people(c, yes)).map((r) => r.first_name)).toEqual(["A"]); // the label for the child
      for (const [u, who] of [[no, "pay false"], [missing, "no pay key"], [expired, "expired"]] as const) {
        expect(await invoices(c, u), who).toEqual([]);
        expect(await payments(c, u), who).toEqual([]);
        expect(await credits(c, u), who).toEqual([]);
        expect((await as(c, u, "select 1 from invoices where id=$1", [inv])).rowCount, who).toBe(0);
        expect((await as(c, u, "select 1 from invoice_lines")).rowCount, who).toBe(0);
      }
    });
  });

  it("staff-only data stays out of reach of the portal: claims, claim summaries, ICD-10 codes, the audit log", () => withClient(async (c) => {
    const { u1, g, p1 } = await seed(c);
    await mkInvoice(c, p1);
    for (const u of [u1, g]) {
      expect((await as(c, u, "select 1 from claim_summary")).rowCount, "claim_summary").toBe(0);
      expect((await as(c, u, "select 1 from claims")).rowCount, "claims").toBe(0);
      expect((await as(c, u, "select 1 from icd10_codes")).rowCount, "icd10").toBe(0);
      expect((await as(c, u, "select 1 from audit_log")).rowCount, "audit").toBe(0);
    }
  }));
});

describe("the pay-now verdict computed from what the patient can read", () => {
  const verdict = async (c: Client, u: string, id: string) => {
    const list = buildPortalInvoices({ invoices: await invoices(c, u) as never, payments: await payments(c, u) as never, credits: await credits(c, u) as never, patients: await people(c, u) as never, userId: u, today: "2030-01-01" });
    return list.find((i) => i.id === id)!;
  };
  const split = (c: Client, p: string) => mkInvoice(c, p, { total: 100000, scheme: 70000, payer: "split" });
  const creditAs = (c: Client, psy: string, i: string, portion: string, amount: number) =>
    as(c, psy, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,$2,'r',$3)", [i, amount, portion]);

  it("self-pay: payable for the outstanding balance, which the database view and the verdict agree on", () => withClient(async (c) => {
    const { psy, u1, p1 } = await seed(c);
    const i = await mkInvoice(c, p1, { total: 95000 });
    await pay(c, psy, i, "cash", 20000);
    await creditAs(c, psy, i, "patient", 5000);
    const v = await verdict(c, u1, i);
    expect(v.payNow).toEqual({ allowed: true, amountCents: 70000 });
    expect(v.outstandingCents).toBe(70000);
    expect(summarise([v])).toMatchObject({ outstandingCents: 70000, payableNowCents: 70000, awaitingSchemeCents: 0 });
  }));

  it("split 700/300, scheme remits 500: refused; with a R200 PATIENT goodwill credit still refused; with a R200 SCHEME write-off allowed for R300", () => withClient(async (c) => {
    const { psy, u1, p1 } = await seed(c);
    const a = await split(c, p1), b = await split(c, p1);
    await remit(c, a, 50000, "REM-A"); await remit(c, b, 50000, "REM-B");
    expect((await verdict(c, u1, a)).payNow).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 50000 });
    await creditAs(c, psy, a, "patient", 20000);
    expect((await verdict(c, u1, a)).payNow).toEqual({ allowed: false, reason: "scheme_pending", amountCents: 30000 });
    await creditAs(c, psy, b, "scheme", 20000);
    expect((await verdict(c, u1, b)).payNow).toEqual({ allowed: true, amountCents: 30000 });
    const s = summarise([await verdict(c, u1, a), await verdict(c, u1, b)]);
    expect(s).toEqual({ outstandingCents: 60000, payableNowCents: 30000, awaitingSchemeCents: 30000, openCount: 2 });
  }));

  it("the scheme paying its whole portion makes the patient portion payable; a guardian with pay sees the same verdict and the child's name", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const g = await guardianWith(c, p1, '{"pay": true}');
    const i = await split(c, p1);
    await remit(c, i, 70000, "REM-1");
    await pay(c, psy, i, "eft", 10000);
    const v = await verdict(c, g, i);
    expect(v.payNow).toEqual({ allowed: true, amountCents: 20000 });
    expect(v.forName).toBe("A");
  }));

  it("a paid invoice and a void invoice offer nothing", () => withClient(async (c) => {
    const { psy, u1, p1 } = await seed(c);
    const paid = await mkInvoice(c, p1, { total: 1000 });
    await pay(c, psy, paid, "eft", 1000);
    const v = await verdict(c, u1, paid);
    expect(v.payNow).toMatchObject({ allowed: false, reason: "paid" });
    expect(v.outstandingCents).toBe(0);
    const gone = await mkInvoice(c, p1, { status: "void" });
    expect((await verdict(c, u1, gone)).payNow).toMatchObject({ allowed: false, reason: "not_payable" });
  }));
});

