import { describe, it, expect } from "vitest";
import type { Client } from "pg";
import { asUser, withClient } from "./helpers";
import { as, grantInsurerConsent, mkInvoice, pay, seed, type Seed } from "./billing-helpers";
import { outstandingCents } from "@/lib/billing/outstanding";
import { payNowAllowed } from "@/lib/billing/pay-now";
import { portionSummary } from "@/lib/billing/portions";

// Parity suite (final review, maintainability). "What is still owed" is computed in four places: the invoice_balances view (0015/0017), report_debtors_detail
// (0025), and the TypeScript helpers outstandingCents, portionSummary and payNowAllowed that the staff and portal pages use. Each scenario builds a real
// invoice through the real functions, then reads the same rows the app reads and fails on ANY drift between the four, and on a change of the expected
// figures or Pay-now decision. A rule changed in one place only (SQL or TS) breaks this file.

type Step = (c: Client, s: Seed, inv: string) => Promise<unknown>;
type Scenario = {
  name: string; payer: "self" | "medical_aid" | "split"; total: number; scheme: number; steps: Step[];
  expect: { status: string; outstanding: number; scheme: number | null; patient: number | null; payNow: boolean; reason?: string };
};

const credit = (amount: number, portion: "patient" | "scheme"): Step => (c, s, inv) =>
  as(c, s.psy, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,$2,'parity',$3)", [inv, amount, portion]);
const eft = (amount: number): Step => (c, s, inv) => pay(c, s.adm, inv, "eft", amount);
const cash = (amount: number): Step => (c, s, inv) => pay(c, s.adm, inv, "cash", amount);
/** a submitted claim for `claimed` and a scheme remittance of `remitted` (a medical_aid payment on the invoice) */
const remit = (claimed: number, remitted: number): Step => async (c, s, inv) => {
  const m = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'Parity','1') returning id", [s.p1])).rows[0].id;
  const cl = (await as(c, s.psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,$3,'{F41.1}') returning id", [inv, m, claimed])).rows[0].id;
  await as(c, s.psy, "update claims set status='submitted' where id=$1", [cl]);
  await as(c, s.psy, "select record_scheme_remittance($1,$2,$3)", [cl, remitted, `RA-${Math.random().toString(36).slice(2, 8)}`]);
};

const SCENARIOS: Scenario[] = [
  { name: "self, nothing paid", payer: "self", total: 95000, scheme: 0, steps: [],
    expect: { status: "issued", outstanding: 95000, scheme: 0, patient: 95000, payNow: true } },
  { name: "self, partial EFT", payer: "self", total: 95000, scheme: 0, steps: [eft(40000)],
    expect: { status: "part_paid", outstanding: 55000, scheme: 0, patient: 55000, payNow: true } },
  { name: "self, paid in full (EFT + cash)", payer: "self", total: 95000, scheme: 0, steps: [eft(50000), cash(45000)],
    expect: { status: "paid", outstanding: 0, scheme: null, patient: null, payNow: false, reason: "paid" } },
  { name: "self, patient credit and a part payment", payer: "self", total: 100000, scheme: 0, steps: [credit(20000, "patient"), eft(30000)],
    expect: { status: "part_paid", outstanding: 50000, scheme: 0, patient: 50000, payNow: true } },
  { name: "self, voided by credit notes (credit-void)", payer: "self", total: 60000, scheme: 0, steps: [credit(60000, "patient")],
    expect: { status: "void", outstanding: 0, scheme: null, patient: null, payNow: false, reason: "not_payable" } },
  { name: "medical aid only, scheme has not paid", payer: "medical_aid", total: 95000, scheme: 95000, steps: [],
    expect: { status: "issued", outstanding: 95000, scheme: 95000, patient: 0, payNow: false, reason: "scheme_pending" } },
  { name: "medical aid only, partial remittance", payer: "medical_aid", total: 95000, scheme: 95000, steps: [remit(95000, 30000)],
    expect: { status: "part_paid", outstanding: 65000, scheme: 65000, patient: 0, payNow: false, reason: "scheme_pending" } },
  { name: "split, scheme portion remitted in full: the patient portion is payable", payer: "split", total: 100000, scheme: 80000, steps: [remit(80000, 80000)],
    expect: { status: "part_paid", outstanding: 20000, scheme: 0, patient: 20000, payNow: true } },
  { name: "split, short remittance written off with a scheme credit", payer: "split", total: 100000, scheme: 80000, steps: [remit(80000, 60000), credit(20000, "scheme")],
    expect: { status: "part_paid", outstanding: 20000, scheme: 0, patient: 20000, payNow: true } },
  { name: "split, patient discount while the scheme is unpaid", payer: "split", total: 100000, scheme: 80000, steps: [credit(5000, "patient")],
    expect: { status: "issued", outstanding: 95000, scheme: 80000, patient: 15000, payNow: false, reason: "scheme_pending" } },
  { name: "split, the patient paid more than their portion before the scheme paid", payer: "split", total: 100000, scheme: 80000, steps: [eft(30000)],
    expect: { status: "part_paid", outstanding: 70000, scheme: 80000, patient: 0, payNow: false, reason: "scheme_pending" } },
  { name: "split, everything settled by remittance and EFT", payer: "split", total: 100000, scheme: 80000, steps: [remit(80000, 80000), eft(20000)],
    expect: { status: "paid", outstanding: 0, scheme: null, patient: null, payNow: false, reason: "paid" } },
];

describe("outstanding parity: invoice_balances = report_debtors_detail = outstandingCents = portionSummary (and the Pay-now decision)", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", (_name, sc) => withClient(async (c) => {
    const s = await seed(c);
    if (sc.payer !== "self") await grantInsurerConsent(c, s.p1);
    const inv = await mkInvoice(c, s.p1, { total: sc.total, scheme: sc.scheme, payer: sc.payer });
    for (const step of sc.steps) await step(c, s, inv);

    // the rows exactly as the app reads them
    const i = (await c.query("select status, payer_type, total_cents, scheme_portion_cents, patient_portion_cents from invoices where id=$1", [inv])).rows[0];
    const credits = (await c.query("select portion, amount_cents from credit_notes where invoice_id=$1", [inv])).rows.map((r) => ({ portion: r.portion as string, amountCents: Number(r.amount_cents) }));
    const payments = (await c.query("select method, amount_cents from payments where invoice_id=$1 and status='succeeded'", [inv])).rows.map((r) => ({ method: r.method as string, amountCents: Number(r.amount_cents) }));
    const creditCents = credits.reduce((a, x) => a + x.amountCents, 0), paidCents = payments.reduce((a, x) => a + x.amountCents, 0);

    // 1. the view, as the psychologist (security invoker: RLS applies, as in the app)
    const view = (await asUser(c, s.psy, () => c.query("select outstanding_cents, paid_cents, credit_cents, scheme_credit_cents, patient_credit_cents from invoice_balances where id=$1", [inv]))).rows[0];
    // 2. the debtors report for today (an invoice with nothing owed is not listed)
    const today = (await c.query("select sa_today()::text d")).rows[0].d;
    const debt = (await asUser(c, s.psy, () => c.query("select outstanding_cents, scheme_cents, patient_cents from report_debtors_detail($1::date) where invoice_number = (select number from invoices where id=$2)", [today, inv]))).rows[0] ?? null;
    // 3./4. the TypeScript helpers on the same rows
    const ts = outstandingCents({ totalCents: i.total_cents, creditCents, paidCents });
    const ps = portionSummary({ status: i.status, totalCents: i.total_cents, schemeCents: i.scheme_portion_cents, patientCents: i.patient_portion_cents, credits, payments });
    const pn = payNowAllowed({ status: i.status, payerType: i.payer_type, totalCents: i.total_cents, schemePortionCents: i.scheme_portion_cents, patientPortionCents: i.patient_portion_cents, credits, payments });

    expect(i.status).toBe(sc.expect.status);
    // the view's own sums are the rows' sums
    expect({ paid: view.paid_cents, credit: view.credit_cents, scheme: view.scheme_credit_cents, patient: view.patient_credit_cents })
      .toEqual({ paid: paidCents, credit: creditCents, scheme: ps.schemeCreditCents, patient: ps.patientCreditCents });
    const open = ["issued", "part_paid"].includes(i.status);
    // every source agrees on what is owed
    const figures = { view: view.outstanding_cents, debtors: debt?.outstanding_cents ?? 0, portionSummary: ps.outstandingCents, outstandingCents: open ? ts : 0, payNowAmount: open ? pn.amountCents : 0 };
    expect(figures).toEqual({ view: sc.expect.outstanding, debtors: sc.expect.outstanding, portionSummary: sc.expect.outstanding, outstandingCents: sc.expect.outstanding, payNowAmount: sc.expect.outstanding });
    // the per-side split agrees between the report and portionSummary
    expect(ps.perPortion ? { scheme: ps.perPortion.schemeCents, patient: ps.perPortion.patientCents } : null)
      .toEqual(sc.expect.scheme === null ? null : { scheme: sc.expect.scheme, patient: sc.expect.patient });
    if (sc.expect.outstanding > 0) expect({ scheme: debt.scheme_cents, patient: debt.patient_cents }).toEqual({ scheme: sc.expect.scheme, patient: sc.expect.patient });
    else expect(debt).toBeNull();
    // the Pay-now decision
    expect({ allowed: pn.allowed, reason: pn.reason }).toEqual({ allowed: sc.expect.payNow, reason: sc.expect.reason });
  }));
});
