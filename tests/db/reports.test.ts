import type { Client } from "pg";
import { it, expect } from "vitest";
import { withClient, asUser, asService } from "./helpers";
import { seed, mkInvoice, mkMaInvoice, pay, as } from "./billing-helpers";

// 0025: report_* functions. Hand-computed expectations; dates are SAST dates; every function is role-guarded, range-validated, aggregate-only.
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const one = async (c: Client, sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];
const today = async (c: Client) => (await one(c, "select sa_today()::text d")).d as string;
const call = (c: Client, u: string, sql: string, p: unknown[] = []) => asUser(c, u, async () => (await c.query(sql, p)).rows);

/** three consecutive calendar months in the past: a = first day of M0, b = first of M1, e = first of M2, z = last day of M2 */
async function months(c: Client) {
  const r = await one(c, `select date_trunc('month', sa_today() - 100)::date::text a, (date_trunc('month', sa_today() - 100) + interval '1 month')::date::text b,
    (date_trunc('month', sa_today() - 100) + interval '2 month')::date::text e, (date_trunc('month', sa_today() - 100) + interval '3 month' - interval '1 day')::date::text z`);
  return r as { a: string; b: string; e: string; z: string };
}

const MONTH_SQL = "select month_start::text m, invoices_n::int n, invoiced_cents::int inv, vat_cents::int vat, vat_credited_cents::int vcr, received_cents::int rec, credit_cents::int cr from report_income_by_month($1,$2)";

async function incomeData(c: Client) {
  const s = await seed(c), m = await months(c);
  const prev = addDays(m.b, -1);
  const A = await mkInvoice(c, s.p1, { total: 100000 });
  const B = await mkInvoice(c, s.p2, { total: 50000 });
  await mkInvoice(c, s.p1, { total: 70000, status: "draft" });
  await mkInvoice(c, s.p2, { total: 20000, status: "void" });
  await c.query("update invoices set issue_date=$2, vat_cents=13043 where id=$1", [A, prev]);
  await c.query("update invoices set issue_date=$2, vat_cents=6522 where id=$1", [B, m.b]);
  await c.query("update invoices set issue_date=$1 where status in ('draft','void')", [m.b]);
  await pay(c, s.psy, A, "eft", 40000, "R1", prev);
  await pay(c, s.psy, A, "cash", 10000, null, m.b);
  await pay(c, s.psy, B, "eft", 50000, "R2", m.b);
  // credit notes: 23:59 SAST on the last day of M0 (21:59Z) and 00:30 SAST on the first day of M1 (22:30Z the day before)
  await c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion,created_at) values ($1,5000,'r','patient',$2::timestamptz)", [A, `${prev}T21:59:00Z`]);
  await c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion,created_at) values ($1,7000,'r','patient',$2::timestamptz)", [A, `${prev}T22:30:00Z`]);
  return { ...s, ...m, prev, A, B };
}

// ---- 1. income by month ----------------------------------------------------------------------------------------------------------------
it("income by month: invoiced / vat / received / credits per SAST month, drafts and void excluded, empty months present", () => withClient(async (c) => {
  const { psy, a, z, b, e } = await incomeData(c);
  expect(await call(c, psy, MONTH_SQL, [a, z])).toEqual([
    { m: a, n: 1, inv: 100000, vat: 13043, vcr: 652, rec: 40000, cr: 5000 },
    { m: b, n: 1, inv: 50000, vat: 6522, vcr: 913, rec: 60000, cr: 7000 },
    { m: e, n: 0, inv: 0, vat: 0, vcr: 0, rec: 0, cr: 0 },
  ]);
}));

it("income by month: only dates inside the range count (partial first and last month)", () => withClient(async (c) => {
  const { psy, a, b, prev } = await incomeData(c);
  expect(await call(c, psy, MONTH_SQL, [a, addDays(b, -2)])).toEqual([{ m: a, n: 0, inv: 0, vat: 0, vcr: 0, rec: 0, cr: 0 }]);
  expect(await call(c, psy, MONTH_SQL, [prev, b])).toEqual([
    { m: a, n: 1, inv: 100000, vat: 13043, vcr: 652, rec: 40000, cr: 5000 },
    { m: b, n: 1, inv: 50000, vat: 6522, vcr: 913, rec: 60000, cr: 7000 },
  ]);
  expect(await call(c, psy, MONTH_SQL, [b, b])).toEqual([{ m: b, n: 1, inv: 50000, vat: 6522, vcr: 913, rec: 60000, cr: 7000 }]);
}));

it("income by month: psychologist, admin and bookkeeper see the same figures", () => withClient(async (c) => {
  const { psy, adm, bk, a, z } = await incomeData(c);
  const want = await call(c, psy, MONTH_SQL, [a, z]);
  expect(await call(c, adm, MONTH_SQL, [a, z])).toEqual(want);
  expect(await call(c, bk, MONTH_SQL, [a, z])).toEqual(want);
}));

// ---- 2. income by method ---------------------------------------------------------------------------------------------------------------
it("income by method: every method listed, succeeded payments by received_on", () => withClient(async (c) => {
  const { psy, a, z, A } = await incomeData(c);
  const M = "select method, payments_n::int n, received_cents::int rec from report_income_by_method($1,$2)";
  expect(await call(c, psy, M, [a, z])).toEqual([
    { method: "payfast", n: 0, rec: 0 }, { method: "eft", n: 2, rec: 90000 }, { method: "cash", n: 1, rec: 10000 },
    { method: "card_machine", n: 0, rec: 0 }, { method: "medical_aid", n: 0, rec: 0 }]);
  await c.query("insert into payments(invoice_id,method,gateway_ref,amount_cents,received_on) values ($1,'payfast','PF-1',2500,$2)", [A, a]);
  await c.query("insert into payments(invoice_id,method,gateway_ref,amount_cents,received_on,status) values ($1,'payfast','PF-2',999,$2,'failed')", [A, a]);
  const r = await call(c, psy, M, [a, z]);
  expect(r[0]).toEqual({ method: "payfast", n: 1, rec: 2500 }); // the failed payment is not money received
}));

// ---- 3. income by session type ---------------------------------------------------------------------------------------------------------
it("income by session type: grouped by the linked appointment's type, 'Other / manual' last, void excluded; the bookkeeper gets the same numbers", () => withClient(async (c) => {
  const { psy, adm, bk, p1, p2 } = await seed(c);
  const t1 = (await one(c, "insert into session_types(name,duration_min,fee_cents) values ('Therapy',50,95000) returning id")).id as string;
  const t2 = (await one(c, "insert into session_types(name,duration_min,fee_cents) values ('Assessment',90,150000) returning id")).id as string;
  const ap = async (p: string, t: string, at: string) => (await one(c, "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,$3::timestamptz,$3::timestamptz + interval '50 min','attended') returning id", [p, t, at])).id as string;
  const mk = async (p: string, total: number, appt: string | null, status = "issued") => {
    const i = await mkInvoice(c, p, { total, status });
    if (appt) await c.query("update invoices set appointment_id=$2 where id=$1", [i, appt]);
    return i;
  };
  await mk(p1, 95000, await ap(p1, t1, "2030-03-04T06:00:00Z"));
  await mk(p2, 90000, await ap(p2, t1, "2030-03-05T06:00:00Z"));
  await mk(p1, 150000, await ap(p1, t2, "2030-03-06T06:00:00Z"));
  await mk(p2, 10000, null);
  await mk(p2, 77000, await ap(p2, t1, "2030-03-07T06:00:00Z"), "void");
  await mk(p2, 66000, null, "draft");
  const d = await today(c);
  const Q = "select session_type, invoices_n::int n, invoiced_cents::int inv from report_income_by_session_type($1,$2)";
  const want = [{ session_type: "Therapy", n: 2, inv: 185000 }, { session_type: "Assessment", n: 1, inv: 150000 }, { session_type: "Other / manual", n: 1, inv: 10000 }];
  for (const u of [psy, adm, bk]) expect(await call(c, u, Q, [d, d])).toEqual(want);
  expect(await call(c, psy, Q, [addDays(d, -30), addDays(d, -1)])).toEqual([]);
}));

// ---- 4. debtors ----------------------------------------------------------------------------------------------------------------------
async function debtors(c: Client) {
  const s = await seed(c), T = await today(c);
  const mk = async (p: string, total: number, due: number, issued: number, o: { payer?: string; scheme?: number; status?: string } = {}) => {
    const i = await mkInvoice(c, p, { total, ...o });
    await c.query("update invoices set due_date=$2, issue_date=$3 where id=$1", [i, addDays(T, due), addDays(T, issued)]);
    return i;
  };
  const i1 = await mk(s.p1, 10000, 5, 0);                    // not yet due
  const i2 = await mk(s.p2, 20000, -10, -30);                // 1-30, R50 paid 5 days ago
  await pay(c, s.psy, i2, "eft", 5000, "D1", addDays(T, -5));
  const { i: i3 } = await mkMaInvoice(c, s.p1, 30000, 24000); // medical aid, 31-60
  await c.query("update invoices set due_date=$2, issue_date=$3 where id=$1", [i3, addDays(T, -45), addDays(T, -50)]);
  await c.query("insert into payments(invoice_id,method,gateway_ref,amount_cents,received_on) values ($1,'medical_aid','RA-1#x',10000,$2)", [i3, addDays(T, -2)]);
  await pay(c, s.psy, i3, "eft", 3000, "D2", addDays(T, -1));
  await c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,4000,'r','scheme')", [i3]);
  const i4 = await mk(s.p2, 40000, -75, -80);                // 61-90
  const i5 = await mk(s.p1, 5000, -120, -130);               // fully credited: the database voids it, so not a debtor
  await c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,5000,'r','patient')", [i5]);
  await mk(s.p1, 9999, -100, -110, { status: "draft" });
  await mk(s.p1, 8888, -100, -110, { status: "void" });
  return { ...s, T, i1, i2, i3, i4, i5 };
}
const DETAIL = "select invoice_number, due_date::text due, days_overdue::int late, bucket, payer_type, outstanding_cents out, scheme_cents sch, patient_cents pat, patient_id from report_debtors_detail($1) order by due_date";

it("debtors detail: outstanding after payments and credits, scheme / patient split (R40), drafts, void and settled invoices left out", () => withClient(async (c) => {
  const { psy, T, p1, p2 } = await debtors(c);
  const rows = await call(c, psy, DETAIL, [T]);
  expect(rows.map((r) => ({ ...r, invoice_number: undefined }))).toEqual([
    { invoice_number: undefined, due: addDays(T, -75), late: 75, bucket: "61-90", payer_type: "self", out: 40000, sch: 0, pat: 40000, patient_id: p2 },
    { invoice_number: undefined, due: addDays(T, -45), late: 45, bucket: "31-60", payer_type: "medical_aid", out: 13000, sch: 10000, pat: 3000, patient_id: p1 },
    { invoice_number: undefined, due: addDays(T, -10), late: 10, bucket: "1-30", payer_type: "self", out: 15000, sch: 0, pat: 15000, patient_id: p2 },
    { invoice_number: undefined, due: addDays(T, 5), late: 0, bucket: "current", payer_type: "self", out: 10000, sch: 0, pat: 10000, patient_id: p1 },
  ]);
  expect(rows.every((r) => /^INV-\d+$/.test(r.invoice_number))).toBe(true);
}));

it("debtors detail: the bookkeeper gets numbers and amounts but no patient id; admin gets it", () => withClient(async (c) => {
  const { adm, bk, T, p1 } = await debtors(c);
  const b = await call(c, bk, DETAIL, [T]);
  expect(b).toHaveLength(4);
  expect(b.every((r) => r.patient_id === null)).toBe(true);
  expect(b.map((r) => r.out)).toEqual([40000, 13000, 15000, 10000]);
  const a = await call(c, adm, DETAIL, [T]);
  expect(a.filter((r) => r.patient_id === p1)).toHaveLength(2);
}));

it("debtors ageing: five buckets in order, zeros included, scheme + patient add up, and the total equals invoice_balances", () => withClient(async (c) => {
  const { psy, T } = await debtors(c);
  const rows = await call(c, psy, "select bucket, invoices_n::int n, outstanding_cents::int out, scheme_cents::int sch, patient_cents::int pat from report_debtors_ageing($1)", [T]);
  expect(rows).toEqual([
    { bucket: "current", n: 1, out: 10000, sch: 0, pat: 10000 },
    { bucket: "1-30", n: 1, out: 15000, sch: 0, pat: 15000 },
    { bucket: "31-60", n: 1, out: 13000, sch: 10000, pat: 3000 },
    { bucket: "61-90", n: 1, out: 40000, sch: 0, pat: 40000 },
    { bucket: "90+", n: 0, out: 0, sch: 0, pat: 0 },
  ]);
  const bal = await one(c, "select sum(outstanding_cents)::int s from invoice_balances");
  expect(rows.reduce((t, r) => t + r.out, 0)).toBe(bal.s);
}));

it("debtors ageing: history. As of 20 days ago a later payment, a later credit and a later invoice are not counted", () => withClient(async (c) => {
  const { psy, T } = await debtors(c);
  // i1 was issued today so it did not exist; i2 (due T-10) was not yet due and still owed R200; i3 (due T-45) owed R300, 25 days late;
  // i4 (due T-75) was 55 days late; i5 (due T-120) owed R50, 100 days late: it was credited off today, which voids it, but it is a booked invoice and owed that on that date
  const rows = await call(c, psy, "select bucket, invoices_n::int n, outstanding_cents::int out from report_debtors_ageing($1)", [addDays(T, -20)]);
  expect(rows).toEqual([
    { bucket: "current", n: 1, out: 20000 }, { bucket: "1-30", n: 1, out: 30000 }, { bucket: "31-60", n: 1, out: 40000 },
    { bucket: "61-90", n: 0, out: 0 }, { bucket: "90+", n: 1, out: 5000 }]);
}));

it("debtors: bucket boundaries match lib/reports/ageing.ts (due today = current, 30 = 1-30, 31 = 31-60, 60, 61, 90, 91)", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c), T = await today(c);
  for (const late of [0, 1, 30, 31, 60, 61, 90, 91]) {
    const i = await mkInvoice(c, p1, { total: 100 + late });
    await c.query("update invoices set due_date=$2, issue_date=$3 where id=$1", [i, addDays(T, -late), addDays(T, -150)]);
  }
  const r = await call(c, psy, "select days_overdue::int late, bucket from report_debtors_detail($1) order by days_overdue", [T]);
  expect(r).toEqual([
    { late: 0, bucket: "current" }, { late: 1, bucket: "1-30" }, { late: 30, bucket: "1-30" }, { late: 31, bucket: "31-60" },
    { late: 60, bucket: "31-60" }, { late: 61, bucket: "61-90" }, { late: 90, bucket: "61-90" }, { late: 91, bucket: "90+" }]);
}));

it("debtors: as-of must be a date between 800 days ago and today", () => withClient(async (c) => {
  const { psy } = await seed(c), T = await today(c);
  for (const fn of ["report_debtors_detail", "report_debtors_ageing"]) {
    await expect(call(c, psy, `select * from ${fn}($1)`, [addDays(T, 1)])).rejects.toThrow(/invalid_range/);
    await expect(call(c, psy, `select * from ${fn}($1)`, [addDays(T, -801)])).rejects.toThrow(/invalid_range/);
    await expect(call(c, psy, `select * from ${fn}(null)`)).rejects.toThrow(/invalid_range/);
    await expect(call(c, psy, `select * from ${fn}($1)`, [addDays(T, -800)])).resolves.toBeDefined();
  }
}));

// ---- 5. appointments -----------------------------------------------------------------------------------------------------------------
async function apptData(c: Client) {
  const s = await seed(c);
  const t1 = (await one(c, "insert into session_types(name,duration_min,fee_cents) values ('Therapy',50,95000) returning id")).id as string;
  const t2 = (await one(c, "insert into session_types(name,duration_min,fee_cents) values ('Assessment',90,150000) returning id")).id as string;
  const ap = async (t: string, at: string, mins: number, status: string) =>
    (await one(c, "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,$3::timestamptz,$3::timestamptz + make_interval(mins => $4),$5) returning id", [s.p1, t, at, mins, status])).id as string;
  // therapy: 3 attended (one at 00:30 SAST on 1 March), 1 no-show, 1 confirmed (23:30 SAST on 31 March), 3 cancelled, 1 tentative (counts nowhere)
  await ap(t1, "2030-03-04T06:00:00Z", 50, "attended");
  await ap(t1, "2030-03-05T06:00:00Z", 50, "attended");
  await ap(t1, "2030-02-28T22:30:00Z", 50, "attended");
  await ap(t1, "2030-03-06T06:00:00Z", 50, "no_show");
  await ap(t1, "2030-03-31T21:30:00Z", 50, "confirmed");
  await ap(t1, "2030-03-12T06:00:00Z", 50, "tentative");
  await ap(t1, "2030-03-31T22:30:00Z", 50, "attended"); // 00:30 SAST on 1 April: outside
  const cancel = async (at: string, daysOrHoursBefore: string | null) => {
    const id = await ap(t1, at, 50, "confirmed");
    await c.query("update appointments set status='cancelled' where id=$1", [id]);
    if (daysOrHoursBefore) await c.query("update appointment_events set at = (select starts_at from appointments where id=$1) - $2::interval where appointment_id=$1 and event='status:cancelled'", [id, daysOrHoursBefore]);
    return id;
  };
  await cancel("2030-03-13T06:00:00Z", "2 hours");  // late: inside the 24 hour window
  await cancel("2030-03-14T06:00:00Z", "3 days");   // early
  await ap(t1, "2030-03-15T06:00:00Z", 50, "cancelled"); // no cancel event on record: cannot be called late
  await ap(t2, "2030-03-07T06:00:00Z", 90, "attended");
  return { ...s, t1, t2 };
}
const APPT = `select session_type, is_total, booked::int, attended::int, no_show::int, cancelled::int, late_cancelled::int late, booked_minutes::int mins,
  available_minutes::int avail, utilisation::float8 util, no_show_rate::float8 nsr, cancellation_rate::float8 cr from report_appointments($1,$2)`;

it("appointments: per session type and in total, with SAST day boundaries, late cancellations and rates", () => withClient(async (c) => {
  const { psy } = await apptData(c);
  const rows = await call(c, psy, APPT, ["2030-03-01", "2030-03-31"]);
  expect(rows).toEqual([
    { session_type: "Assessment", is_total: false, booked: 1, attended: 1, no_show: 0, cancelled: 0, late: 0, mins: 90, avail: null, util: null, nsr: 0, cr: 0 },
    { session_type: "Therapy", is_total: false, booked: 5, attended: 3, no_show: 1, cancelled: 3, late: 1, mins: 250, avail: null, util: null, nsr: 0.25, cr: 0.375 },
    { session_type: "All session types", is_total: true, booked: 6, attended: 4, no_show: 1, cancelled: 3, late: 1, mins: 340, avail: null, util: null, nsr: 0.2, cr: 0.3333 },
  ]);
}));

it("appointments: utilisation is booked minutes over availability, minus blocked time counted once; NULL with no availability", () => withClient(async (c) => {
  const { psy } = await apptData(c);
  // Mondays 08:00-12:00 SAST (4 in March 2030: 4, 11, 18, 25) and Wednesdays 14:00-16:00 (6, 13, 20, 27): 960 + 480 = 1440 minutes
  await c.query("insert into availability_rules(weekday,start_time,end_time) values (1,'08:00','12:00'),(3,'14:00','16:00')");
  // 11 March 09:00-10:00 and 09:30-10:30 SAST overlap: 90 minutes once; 18 March 14:00-15:00 is outside the hours; 25 March 07:00-09:00 overlaps 60 minutes
  await c.query(`insert into blocked_times(starts_at,ends_at) values ('2030-03-11T07:00:00Z','2030-03-11T08:00:00Z'),('2030-03-11T07:30:00Z','2030-03-11T08:30:00Z'),
    ('2030-03-18T12:00:00Z','2030-03-18T13:00:00Z'),('2030-03-25T05:00:00Z','2030-03-25T07:00:00Z')`);
  const t = (await call(c, psy, APPT, ["2030-03-01", "2030-03-31"])).find((r) => r.is_total)!;
  expect(t.avail).toBe(1440 - 90 - 60);
  expect(t.util).toBe(0.2636); // 340 / 1290
  // a range with no Monday or Wednesday has no availability: utilisation is NULL, not 0 and not an error
  const none = (await call(c, psy, APPT, ["2030-03-08", "2030-03-09"])).find((r) => r.is_total)!;
  expect(none.avail).toBeNull();
  expect(none.util).toBeNull();
}));

it("appointments: an empty range gives a total row of zeros and NULL rates", () => withClient(async (c) => {
  const { psy } = await seed(c);
  expect(await call(c, psy, APPT, ["2031-01-01", "2031-01-31"])).toEqual([
    { session_type: "All session types", is_total: true, booked: 0, attended: 0, no_show: 0, cancelled: 0, late: 0, mins: 0, avail: null, util: null, nsr: null, cr: null }]);
}));

it("appointments: late cancellation uses the practice's window (hours)", () => withClient(async (c) => {
  const { psy } = await apptData(c);
  await c.query("update practices set cancellation_window_hours = 1");
  const t = (await call(c, psy, APPT, ["2030-03-01", "2030-03-31"])).find((r) => r.is_total)!;
  expect(t.late).toBe(0); // cancelled 2 hours before is outside a one hour window
}));

// ---- 6. practice activity ------------------------------------------------------------------------------------------------------------
async function activityData(c: Client) {
  const s = await seed(c);
  const pt = (at: string, ref: string | null, status = "active") =>
    c.query("insert into patients(first_name,last_name,referral_source,status,created_at) values ('N','N',$2,$3,$1::timestamptz)", [at, ref, status]);
  await pt("2030-01-10T08:00:00Z", "GP"); await pt("2030-01-20T08:00:00Z", "gp ");
  await pt("2030-02-10T08:00:00Z", null);
  await pt("2030-03-10T08:00:00Z", "Facebook"); await pt("2030-02-28T22:30:00Z", ""); // 00:30 SAST on 1 March
  await pt("2030-03-31T22:30:00Z", "Late"); // 00:30 SAST on 1 April: outside
  const t = (await one(c, "insert into session_types(name,duration_min,fee_cents) values ('Therapy',50,95000) returning id")).id as string;
  const ap = (p: string, at: string, st: string) => c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,$3::timestamptz,$3::timestamptz + interval '50 min',$4)", [p, t, at, st]);
  await ap(s.p1, "2029-12-31T21:30:00Z", "attended"); // 23:30 SAST on 31 Dec 2029: outside the 90 days up to 31 March
  await ap(s.p2, "2029-12-31T22:30:00Z", "attended"); // 00:30 SAST on 1 Jan 2030: the first day inside
  await ap(s.p2, "2030-03-05T06:00:00Z", "attended"); // same patient again: counted once
  await ap(s.p1, "2030-03-06T06:00:00Z", "no_show");  // not attended
  const tk = (title: string, source: string | null, at: string, st: string) => c.query("insert into tasks(title,source,status,created_at) values ($1,$2,$3,$4::timestamptz)", [title, source, st, at]);
  await tk("a", "manual", "2030-01-05T08:00:00Z", "open");
  await tk("b", "manual", "2030-02-05T08:00:00Z", "done");
  await tk("c", "overdue_invoice:1", "2030-03-05T08:00:00Z", "done");
  await tk("d", "manual", "2030-03-31T22:30:00Z", "open");   // 1 April SAST: outside
  await tk("r", "risk_flag:1", "2030-02-05T08:00:00Z", "done"); // clinical: never counted
  await tk("p1", "payfast_unreconciled:1", "2029-01-01T08:00:00Z", "open");
  await tk("p2", "payfast_unreconciled:2", "2029-01-01T08:00:00Z", "open");
  await tk("p3", "payfast_unreconciled:3", "2029-01-01T08:00:00Z", "done");
  const inv = await mkInvoice(c, s.p1, { total: 1000 });
  const m = (await one(c, "insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'S','1') returning id", [s.p1])).id as string;
  for (const [st, at] of [["draft", "2030-01-15T08:00:00Z"], ["draft", "2030-02-15T08:00:00Z"], ["rejected", "2030-03-15T08:00:00Z"], ["draft", "2030-04-15T08:00:00Z"]])
    await c.query("insert into claims(invoice_id,member_id,status,created_at,rejection_reason) values ($1,$2,$3,$4::timestamptz,case when $3 = 'rejected' then 'x' end)", [inv, m, st, at]);
  return s;
}
const ACT = "select section, label, detail, n::int n from report_practice_activity($1,$2)";
const sec = (rows: { section: string; label: string; n: number }[], s: string) => rows.filter((r) => r.section === s).map((r) => [r.label, r.n]);

it("practice activity: new patients per month, referral sources, caseload, tasks, claims, open PayFast", () => withClient(async (c) => {
  const { psy } = await activityData(c);
  const rows = await call(c, psy, ACT, ["2030-01-01", "2030-03-31"]);
  expect(sec(rows, "new_patients")).toEqual([["2030-01", 2], ["2030-02", 1], ["2030-03", 2]]);
  expect(Object.fromEntries(sec(rows, "referral"))).toEqual({ GP: 2, "Not recorded": 2, Facebook: 1 });
  expect(sec(rows, "caseload")).toEqual([["active", 1]]);
  expect(Object.fromEntries(sec(rows, "tasks"))).toEqual({ created: 3, completed: 2 }); // risk_flag and out-of-range tasks left out
  expect(Object.fromEntries(sec(rows, "claims"))).toEqual({ draft: 2, rejected: 1 });
  expect(sec(rows, "payfast_open")).toEqual([["open", 2]]);
  expect(rows.every((r) => r.detail === null)).toBe(true);
}));

it("practice activity: the psychologist and the admin get identical figures (risk tasks never leak into the difference)", () => withClient(async (c) => {
  const { psy, adm } = await activityData(c);
  expect(await call(c, adm, ACT, ["2030-01-01", "2030-03-31"])).toEqual(await call(c, psy, ACT, ["2030-01-01", "2030-03-31"]));
}));

it("practice activity: months with no new patients are still listed", () => withClient(async (c) => {
  const { psy } = await activityData(c);
  expect(sec(await call(c, psy, ACT, ["2030-04-01", "2030-06-30"]), "new_patients")).toEqual([["2030-04", 1], ["2030-05", 0], ["2030-06", 0]]);
}));

// ---- 7. compliance ---------------------------------------------------------------------------------------------------------------------
const COMP = "select section, label, detail, n::int n from report_compliance($1,$2)";
async function complianceData(c: Client) {
  const s = await seed(c);
  const log = async (action: string, at: string, times = 1) => {
    for (let k = 0; k < times; k++) await c.query("insert into audit_log(actor_id,role,action,at) values ($1,'psychologist',$2,$3::timestamptz)", [s.psy, action, at]);
  };
  await log("auth.login", "2030-03-02T08:00:00Z", 3); await log("auth.login", "2030-03-31T22:30:00Z"); // 1 April SAST: outside
  await log("patient.view", "2030-03-03T08:00:00Z", 2); await log("note.view", "2030-03-03T08:00:00Z"); await log("claim.view", "2030-03-03T08:00:00Z");
  await log("export.audit", "2030-03-04T08:00:00Z"); await log("export.report", "2030-03-04T09:00:00Z");
  await log("practice.update", "2030-03-05T08:00:00Z"); await log("settings.session_type", "2030-03-05T09:00:00Z");
  await log("consent.grant", "2030-03-06T08:00:00Z", 2); await log("consent.withdraw", "2030-03-06T09:00:00Z"); await log("note.addendum", "2030-03-07T08:00:00Z");
  await log("payfast.itn.rejected", "2030-03-08T08:00:00Z", 2); await log("audit.view", "2030-03-08T08:00:00Z", 5);
  await c.query("insert into tasks(title,source,created_at) values ('n','outbox_failed:1','2030-03-09T08:00:00Z'),('n','outbox_failed:2','2030-04-09T08:00:00Z')");
  const p3 = (await one(c, "insert into patients(first_name,last_name,status) values ('X','X','archived') returning id")).id as string;
  await c.query("insert into consents(patient_id,purpose,granted,granted_at) values ($1,'treatment',true,now()),($2,'treatment',true,now()),($1,'privacy_notice',false,null),($3,'treatment',true,now())", [s.p1, s.p2, p3]);
  return s;
}

it("compliance: counts by action family, consent status now, failed notifications and PayFast rejections; nothing is row-level", () => withClient(async (c) => {
  const { psy } = await complianceData(c);
  const rows = await call(c, psy, COMP, ["2030-03-01", "2030-03-31"]);
  expect(Object.fromEntries(sec(rows, "activity"))).toEqual({
    logins: 3, patient_views: 2, note_views: 1, claim_views: 1, exports: 2, settings_changes: 2, consent_grants: 2, consent_withdrawals: 1, note_addenda: 1 });
  const consent = Object.fromEntries(rows.filter((r) => r.section === "consent").map((r) => [`${r.label}:${r.detail}`, r.n]));
  expect(consent["treatment:granted"]).toBe(2); // the archived patient's consent is not counted
  expect(consent["treatment:withdrawn"]).toBe(0);
  expect(consent["treatment:none"]).toBe(0);
  expect(consent["privacy_notice:withdrawn"]).toBe(1);
  expect(consent["privacy_notice:none"]).toBe(1);
  expect(consent["telehealth:none"]).toBe(2);
  expect(rows.filter((r) => r.section === "consent")).toHaveLength(18);
  expect(sec(rows, "failed_notifications")).toEqual([["failed", 1]]);
  expect(sec(rows, "payfast_rejected")).toEqual([["rejected", 2]]);
}));

it("compliance: psychologist only", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, g } = await seed(c);
  await expect(call(c, psy, COMP, ["2030-03-01", "2030-03-31"])).resolves.toBeDefined();
  for (const u of [adm, bk, assoc, u1, g]) await expect(call(c, u, COMP, ["2030-03-01", "2030-03-31"])).rejects.toThrow(/forbidden/);
}));

// ---- 8. transactions -----------------------------------------------------------------------------------------------------------------
const TX = "select txn_date::text d, kind, invoice_number inv, method, reference ref, portion, amount_cents::int amt, vat_cents::int vat from report_transactions($1,$2)";
async function txData(c: Client, vatRegistered: boolean) {
  const s = await seed(c), d = await today(c);
  if (vatRegistered) await c.query("update practices set vat_registered = true");
  const A = await mkInvoice(c, s.p1, { total: 11500 });
  await c.query("update invoices set vat_cents=1500 where id=$1", [A]);
  const { i: M } = await mkMaInvoice(c, s.p2, 20000, 16000);
  const num = async (i: string) => (await one(c, "select number from invoices where id=$1", [i])).number as string;
  await pay(c, s.psy, A, "eft", 5750, "BANK-1", addDays(d, -3));
  await pay(c, s.psy, A, "cash", 1000, null, addDays(d, -2));
  await c.query("insert into payments(invoice_id,method,gateway_ref,amount_cents,received_on) values ($1,'payfast','PF-99',2000,$2)", [A, addDays(d, -2)]);
  await c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion,created_at) values ($1,1150,'r','patient',$2::timestamptz)", [A, `${addDays(d, -1)}T08:00:00Z`]);
  const claim = (await one(c, "insert into claims(invoice_id,member_id,claimed_cents) values ($1,(select id from medical_aid_members where patient_id=$2),16000) returning id", [M, s.p2])).id as string;
  const pid = (await one(c, "insert into payments(invoice_id,method,gateway_ref,amount_cents,received_on) values ($1,'medical_aid','RA-7#'||$2::text,16000,$3) returning id", [M, claim, addDays(d, -1)])).id as string;
  await c.query("insert into claim_payments(claim_id,payment_id,amount_cents,remittance_ref) values ($1,$2,16000,'RA-7')", [claim, pid]);
  await c.query("insert into payments(invoice_id,method,reference,amount_cents,received_on,status) values ($1,'cash','X',500,$2,'pending')", [A, d]); // not succeeded
  return { ...s, d, A, M, nA: await num(A), nM: await num(M) };
}

it("transactions: one row per succeeded payment and a negative row per credit note, with references and a proportional VAT portion", () => withClient(async (c) => {
  const { psy, d, nA, nM } = await txData(c, true);
  expect(await call(c, psy, TX, [addDays(d, -10), d])).toEqual([
    { d: addDays(d, -3), kind: "payment", inv: nA, method: "eft", ref: "BANK-1", portion: "patient", amt: 5750, vat: 750 },
    { d: addDays(d, -2), kind: "payment", inv: nA, method: "cash", ref: null, portion: "patient", amt: 1000, vat: 130 },
    { d: addDays(d, -2), kind: "payment", inv: nA, method: "payfast", ref: "PF-99", portion: "patient", amt: 2000, vat: 261 },
    { d: addDays(d, -1), kind: "credit_note", inv: nA, method: "credit_note", ref: null, portion: "patient", amt: -1150, vat: -150 },
    { d: addDays(d, -1), kind: "payment", inv: nM, method: "medical_aid", ref: "RA-7", portion: "scheme", amt: 16000, vat: 0 },
  ]);
}));

it("transactions: the VAT column is null when the practice is not VAT registered; a credit note after midnight SAST lands on the next day", () => withClient(async (c) => {
  const { psy, d, A } = await txData(c, false);
  expect((await call(c, psy, TX, [addDays(d, -10), d])).every((r) => r.vat === null)).toBe(true);
  await c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion,created_at) values ($1,100,'r','patient',$2::timestamptz)", [A, `${addDays(d, -5)}T22:30:00Z`]);
  const rows = await call(c, psy, TX, [addDays(d, -4), addDays(d, -4)]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ kind: "credit_note", amt: -100 });
}));

it("transactions: psychologist, admin and bookkeeper get the same rows; the output has no patient column; the cap is 20000 rows", () => withClient(async (c) => {
  const { psy, adm, bk, d, A } = await txData(c, true);
  const want = await call(c, psy, TX, [addDays(d, -10), d]);
  expect(await call(c, adm, TX, [addDays(d, -10), d])).toEqual(want);
  expect(await call(c, bk, TX, [addDays(d, -10), d])).toEqual(want);
  await c.query("alter table payments disable trigger user");
  await c.query("insert into payments(invoice_id,method,amount_cents,received_on) select $1,'cash',1,$2::date from generate_series(1,20000)", [A, addDays(d, -7)]);
  await expect(call(c, psy, TX, [addDays(d, -10), d])).rejects.toThrow(/too_many_rows/);
  expect(await call(c, psy, TX, [addDays(d, -7), addDays(d, -7)])).toHaveLength(20000);
}));

// ---- credit-voided invoices stay booked (fix round 1, I-1) -----------------------------------------------------------------------------
// A credit note that settles an unpaid invoice in full makes the database void it. That invoice was still invoiced, and the credit is still a credit: closed months
// must not change, and the accountant's export must keep the credit row. A void invoice with no credits (a manual void) stays out.
async function creditVoidData(c: Client) {
  const s = await seed(c), m = await months(c);
  await c.query("update practices set vat_registered = true");
  const mid0 = addDays(m.a, 10), mid1 = addDays(m.b, 10);
  const mk = async (total: number, vat: number, status = "issued") => {
    const i = await mkInvoice(c, s.p1, { total, status });
    await c.query("update invoices set issue_date=$2, vat_cents=$3 where id=$1", [i, mid0, vat]);
    return i;
  };
  const credit = (i: string, cents: number, at: string) =>
    c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion,created_at) values ($1,$2,'r','patient',$3::timestamptz)", [i, cents, `${at}T10:00:00Z`]);
  return { ...s, ...m, mid0, mid1, mk, credit };
}
const MONTH2 = "select month_start::text m, invoices_n::int n, invoiced_cents::int inv, vat_cents::int vat, vat_credited_cents::int vcr, received_cents::int rec, credit_cents::int cr from report_income_by_month($1,$2)";

it("a full credit in a later month: the issue month keeps its invoiced total and VAT, the credit month shows the credit and its VAT, and re-running the closed month gives the same figures", () => withClient(async (c) => {
  const { psy, a, b, z, mk, credit, mid1 } = await creditVoidData(c);
  const X = await mk(11500, 1500);
  const before = await call(c, psy, MONTH2, [a, z]);
  expect(before[0]).toEqual({ m: a, n: 1, inv: 11500, vat: 1500, vcr: 0, rec: 0, cr: 0 });
  await credit(X, 11500, mid1); // unpaid, so the database voids the invoice
  expect((await one(c, "select status from invoices where id=$1", [X])).status).toBe("void");
  const after = await call(c, psy, MONTH2, [a, z]);
  expect(after[0]).toEqual(before[0]); // M0 unchanged
  expect(after[1]).toEqual({ m: b, n: 0, inv: 0, vat: 0, vcr: 1500, rec: 0, cr: 11500 });
}));

it("transactions: the full credit of a credit-voided invoice is a negative row with negative VAT", () => withClient(async (c) => {
  const { psy, mk, credit, mid1 } = await creditVoidData(c);
  const X = await mk(11500, 1500);
  await credit(X, 11500, mid1);
  const n = (await one(c, "select number from invoices where id=$1", [X])).number as string;
  expect(await call(c, psy, TX, [mid1, mid1])).toEqual([{ d: mid1, kind: "credit_note", inv: n, method: "credit_note", ref: null, portion: "patient", amt: -11500, vat: -1500 }]);
}));

it("a partial credit and then the remainder: VAT on the two credits adds up to the invoice VAT exactly; a manually voided invoice stays out", () => withClient(async (c) => {
  const { psy, a, z, b, mk, credit, mid0, mid1 } = await creditVoidData(c);
  const X = await mk(11500, 1500), Y = await mk(20000, 2609), Z = await mk(8000, 1043, "void"); // Z: voided by hand, no credits
  await credit(Y, 5000, mid0);
  await credit(Y, 15000, mid1); // 5000 + 15000 = the whole invoice: voided by credits
  expect((await one(c, "select status from invoices where id=$1", [Y])).status).toBe("void");
  void X; void Z;
  const rows = await call(c, psy, MONTH2, [a, z]);
  // M0: X + Y invoiced (Z is not); credit 5000 -> round(5000 * 2609 / 20000) = 652
  expect(rows[0]).toEqual({ m: a, n: 2, inv: 31500, vat: 4109, vcr: 652, rec: 0, cr: 5000 });
  // M1: the remainder 15000 carries 2609 - 652 = 1957
  expect(rows[1]).toEqual({ m: b, n: 0, inv: 0, vat: 0, vcr: 1957, rec: 0, cr: 15000 });
  expect(rows[0].vcr + rows[1].vcr).toBe(2609);
  const tx = await call(c, psy, TX, [mid0, mid1]);
  expect(tx.map((r) => [r.d, r.amt, r.vat])).toEqual([[mid0, -5000, -652], [mid1, -15000, -1957]]);
  const st = await call(c, psy, "select session_type, invoices_n::int n, invoiced_cents::int inv from report_income_by_session_type($1,$2)", [a, z]);
  expect(st).toEqual([{ session_type: "Other / manual", n: 2, inv: 31500 }]); // X and Y, not Z
}));

it("debtors as at a date before the credit still list the invoice; after the credit (and for a manual void) they do not", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c);
  const T = await today(c);
  const mk = async (total: number, status = "issued") => {
    const i = await mkInvoice(c, p1, { total, status });
    await c.query("update invoices set issue_date=$2, due_date=$3 where id=$1", [i, addDays(T, -60), addDays(T, -40)]);
    return i;
  };
  const credit = (i: string, cents: number, at: string) =>
    c.query("insert into credit_notes(invoice_id,amount_cents,reason,portion,created_at) values ($1,$2,'r','patient',$3::timestamptz)", [i, cents, `${at}T10:00:00Z`]);
  const X = await mk(11500), Y = await mk(20000), Z = await mk(7000, "void");
  await credit(X, 11500, addDays(T, -10));          // voided by credits 10 days ago
  await credit(Y, 5000, addDays(T, -30)); await credit(Y, 15000, addDays(T, -10));
  const owed = async (asOf: string) => (await call(c, psy, "select outstanding_cents::int out, days_overdue::int late, bucket from report_debtors_detail($1) order by outstanding_cents", [asOf]));
  expect(await owed(addDays(T, -35))).toEqual([{ out: 11500, late: 5, bucket: "1-30" }, { out: 20000, late: 5, bucket: "1-30" }]); // before any credit
  expect(await owed(addDays(T, -20))).toEqual([{ out: 11500, late: 20, bucket: "1-30" }, { out: 15000, late: 20, bucket: "1-30" }]); // Y partly credited
  expect(await owed(T)).toEqual([]); // both credited off; Z was never booked
  expect(await owed(addDays(T, -70))).toEqual([]); // before they were issued
  void Z;
}));

it("VAT on payments is worked out from the running total paid, so the VAT of an invoice's payments adds up to the invoice VAT exactly", () => withClient(async (c) => {
  const { psy, p1 } = await seed(c), T = await today(c);
  await c.query("update practices set vat_registered = true");
  const i = await mkInvoice(c, p1, { total: 10000 });
  await c.query("update invoices set vat_cents=1304 where id=$1", [i]);
  await pay(c, psy, i, "eft", 3333, "V1", addDays(T, -3));
  await pay(c, psy, i, "eft", 3333, "V2", addDays(T, -2));
  await pay(c, psy, i, "eft", 3334, "V3", addDays(T, -1));
  const rows = await call(c, psy, TX, [addDays(T, -3), T]);
  expect(rows.map((r) => [r.amt, r.vat])).toEqual([[3333, 435], [3333, 434], [3334, 435]]); // 435.0 -> running 869 -> 1304
  expect(rows.reduce((t, r) => t + r.vat, 0)).toBe(1304);
}));

// ---- shared: roles, ranges, grants, shape ---------------------------------------------------------------------------------------------
const RANGE_FNS: { fn: string; roles: "money" | "staff" | "psychologist" }[] = [
  { fn: "report_income_by_month", roles: "money" }, { fn: "report_income_by_method", roles: "money" }, { fn: "report_income_by_session_type", roles: "money" },
  { fn: "report_transactions", roles: "money" }, { fn: "report_appointments", roles: "staff" }, { fn: "report_practice_activity", roles: "staff" }, { fn: "report_compliance", roles: "psychologist" },
];
const ALL_FNS = [...RANGE_FNS.map((f) => `${f.fn}(date, date)`), "report_debtors_detail(date)", "report_debtors_ageing(date)"];

it("role matrix: each report allows exactly its roles; patients, guardians and associates are refused everywhere; admin and bookkeeper where stated", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, g } = await seed(c);
  const who = { psychologist: psy, admin: adm, bookkeeper: bk, associate: assoc, patient: u1, guardian: g };
  const allowed: Record<string, string[]> = {
    money: ["psychologist", "admin", "bookkeeper"], staff: ["psychologist", "admin"], psychologist: ["psychologist"] };
  for (const { fn, roles } of RANGE_FNS) {
    for (const [role, u] of Object.entries(who)) {
      const run = call(c, u, `select * from ${fn}('2030-03-01','2030-03-31')`);
      if (allowed[roles].includes(role)) await expect(run, `${fn} as ${role}`).resolves.toBeDefined();
      else await expect(run, `${fn} as ${role}`).rejects.toThrow(/forbidden/);
    }
  }
  const T = await today(c);
  for (const fn of ["report_debtors_detail", "report_debtors_ageing"])
    for (const [role, u] of Object.entries(who)) {
      const run = call(c, u, `select * from ${fn}($1)`, [T]);
      if (allowed.money.includes(role)) await expect(run, `${fn} as ${role}`).resolves.toBeDefined();
      else await expect(run, `${fn} as ${role}`).rejects.toThrow(/forbidden/);
    }
}));

it("anonymous callers have no EXECUTE; a service-role call has no staff role and is refused", () => withClient(async (c) => {
  await c.query("set local role anon");
  for (const { fn } of RANGE_FNS) await expect(c.query(`select * from ${fn}('2030-03-01','2030-03-31')`)).rejects.toThrow(/permission denied/);
  await expect(c.query("select * from report_debtors_detail(current_date)")).rejects.toThrow(/permission denied/);
  await expect(c.query("select * from report_debtors_ageing(current_date)")).rejects.toThrow(/permission denied/);
  await c.query("reset role");
  for (const { fn } of RANGE_FNS) await expect(asService(c, () => c.query(`select * from ${fn}('2030-03-01','2030-03-31')`))).rejects.toThrow(/forbidden/);
  await expect(asService(c, () => c.query("select * from report_debtors_ageing(current_date)"))).rejects.toThrow(/forbidden/);
}));

it("range validation: null, reversed and over 800 days are invalid_range for every ranged report; exactly 800 days apart is accepted", () => withClient(async (c) => {
  const { psy } = await seed(c);
  for (const { fn } of RANGE_FNS) {
    await expect(call(c, psy, `select * from ${fn}(null,'2030-03-31')`), fn).rejects.toThrow(/invalid_range/);
    await expect(call(c, psy, `select * from ${fn}('2030-03-01',null)`), fn).rejects.toThrow(/invalid_range/);
    await expect(call(c, psy, `select * from ${fn}('2030-03-31','2030-03-01')`), fn).rejects.toThrow(/invalid_range/);
    await expect(call(c, psy, `select * from ${fn}('2030-01-01', date '2030-01-01' + 801)`), fn).rejects.toThrow(/invalid_range/);
    await expect(call(c, psy, `select * from ${fn}('2030-01-01', date '2030-01-01' + 800)`), fn).resolves.toBeDefined();
    await expect(call(c, psy, `select * from ${fn}('2030-03-01','2030-03-01')`), fn).resolves.toBeDefined(); // a single day is fine
  }
}));

it("every report function is SECURITY INVOKER (except session type, see its comment), pins its search_path, and is granted to authenticated + service_role only", () => withClient(async (c) => {
  for (const sig of ALL_FNS) {
    const name = sig.split("(")[0];
    const p = await one(c, "select prosecdef, proconfig from pg_proc where proname = $1", [name]);
    expect(p.prosecdef, name).toBe(name === "report_income_by_session_type");
    expect(p.proconfig, name).toContain("search_path=public, pg_temp");
    const g = await one(c, `select has_function_privilege('anon', '${sig}', 'execute') a, has_function_privilege('authenticated', '${sig}', 'execute') b,
      has_function_privilege('service_role', '${sig}', 'execute') s, has_function_privilege('public', '${sig}', 'execute') p`);
    expect(g, sig).toEqual({ a: false, b: true, s: true, p: false });
  }
}));

it("no result carries patient identity: no column named for a patient except patient_id in the debtors detail, and no uuid-typed column elsewhere", () => withClient(async (c) => {
  const rows = (await c.query(`select proname, pg_get_function_result(oid) res from pg_proc where proname like 'report\\_%' and pronamespace = 'public'::regnamespace order by proname`)).rows;
  expect(rows.map((r) => r.proname)).toEqual([
    "report_appointments", "report_compliance", "report_debtors_ageing", "report_debtors_detail", "report_income_by_method", "report_income_by_month",
    "report_income_by_session_type", "report_practice_activity", "report_transactions"]);
  for (const r of rows) {
    expect(r.res, r.proname).not.toMatch(/name_|first_name|last_name|email|phone|date_of_birth|patient_name/);
    if (r.proname === "report_debtors_detail") expect(r.res).toMatch(/patient_id uuid/);
    else expect(r.res, r.proname).not.toMatch(/uuid|patient_id/);
  }
}));

it("the definer session-type report gives the bookkeeper aggregates only: three columns, no ids or times, while appointments stay unreadable to them and the session-type names are not patient data", () => withClient(async (c) => {
  const { bk, p1 } = await seed(c);
  const t = (await one(c, "insert into session_types(name,duration_min,fee_cents) values ('Therapy',50,95000) returning id")).id as string;
  const ap = (await one(c, "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,'2030-03-04T06:00:00Z','2030-03-04T06:50:00Z','attended') returning id", [p1, t])).id as string;
  const i = await mkInvoice(c, p1, { total: 95000 });
  await c.query("update invoices set appointment_id=$2 where id=$1", [i, ap]);
  const d = await today(c);
  const res = await asUser(c, bk, () => c.query("select * from report_income_by_session_type($1,$2)", [d, d]));
  expect(res.fields.map((f) => f.name)).toEqual(["session_type", "invoices_n", "invoiced_cents"]);
  expect(JSON.stringify(res.rows)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no uuid anywhere in the output
  expect(res.rows).toEqual([{ session_type: "Therapy", invoices_n: "1", invoiced_cents: "95000" }]);
  // the same bookkeeper cannot read the underlying rows, and an invoker report function used by a role with no staff role fails closed
  expect((await as(c, bk, "select 1 from appointments")).rowCount).toBe(0);
  expect((await as(c, bk, "select 1 from patients")).rowCount).toBe(0);
  await expect(asService(c, () => c.query("select * from report_income_by_month($1,$2)", [d, d]))).rejects.toThrow(/forbidden/);
}));
