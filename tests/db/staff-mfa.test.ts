import { it, expect } from "vitest";
import type { Client } from "pg";
import { asUser, mkUser, withClient } from "./helpers";
import { mkInvoice } from "./billing-helpers";

// 0030 (final review C1): staff need a two-step (aal2) session IN THE DATABASE, not only in the Next.js pages. A password-only (aal1) staff token used
// directly against PostgREST gets no application role from auth_role(): it reads none of the practice's data and every staff function refuses it.

async function world(c: Client) {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), bk = await mkUser(c, "bookkeeper"), assoc = await mkUser(c, "associate");
  const u = await mkUser(c, "patient");
  const p = (await c.query("insert into patients(user_id,first_name,last_name,email) values ($1,'A','A','a@x.test') returning id", [u])).rows[0].id as string;
  const lone = (await c.query("insert into patients(first_name,last_name,email) values ('L','L','l@x.test') returning id")).rows[0].id as string;
  await c.query("insert into clinical_notes(patient_id,author_id,content) values ($1,$2,'{\"notes\":\"x\"}')", [p, psy]);
  const tpl = (await c.query(`insert into form_templates(key,version,schema) values ('mfa_t',1,'{"fields":[{"key":"a","label":"A","type":"text"}]}') returning id`)).rows[0].id;
  await c.query("insert into form_submissions(patient_id,template_id,answers) values ($1,$2,'{}')", [p, tpl]);
  const inv = await mkInvoice(c, p);
  await c.query("insert into audit_log(action,entity,entity_id) values ('patient.view','patients',$1)", [p]);
  return { psy, adm, bk, assoc, u, p, lone, inv };
}
const n = async (c: Client, who: string, sql: string, aal: "aal1" | "aal2", params: unknown[] = []) =>
  (await asUser(c, who, () => c.query(sql, params), { aal })).rowCount;

it("auth_role() names a staff role only with an aal2 session; patients and guardians keep theirs at aal1", () => withClient(async (c) => {
  const w = await world(c);
  const g = await mkUser(c, "guardian");
  const role = (who: string, aal: "aal1" | "aal2") => asUser(c, who, async () => (await c.query("select auth_role()::text r, is_staff() s")).rows[0], { aal });
  for (const s of [w.psy, w.adm, w.bk, w.assoc]) {
    expect(await role(s, "aal1")).toEqual({ r: null, s: false });
    expect((await role(s, "aal2")).s).toBe(true);
  }
  expect((await role(w.psy, "aal2")).r).toBe("psychologist");
  expect(await role(w.u, "aal1")).toEqual({ r: "patient", s: false });
  expect(await role(g, "aal1")).toEqual({ r: "guardian", s: false });
  // no aal claim at all (an older or hand-made token) counts as aal1
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: w.psy, role: "authenticated" })]);
  try { expect((await c.query("select auth_role() r")).rows[0].r).toBeNull(); }
  finally { await c.query("reset role"); await c.query("select set_config('request.jwt.claims', '', true)"); }
}));

it("an aal1 psychologist, admin or bookkeeper reads nothing of the practice's data; with aal2 the same queries return rows", () => withClient(async (c) => {
  const w = await world(c);
  const reads: [string, string[]][] = [
    ["select 1 from clinical_notes", [w.psy]],
    ["select 1 from form_submissions", [w.psy, w.adm]],
    ["select 1 from invoices", [w.psy, w.adm, w.bk]],
    ["select 1 from invoice_balances", [w.psy, w.adm, w.bk]],
    ["select 1 from audit_log", [w.psy]],
    ["select 1 from patients", [w.psy, w.adm]],
    ["select 1 from claim_summary", []],
  ];
  for (const [sql, readers] of reads) {
    for (const s of [w.psy, w.adm, w.bk, w.assoc]) expect(await n(c, s, sql, "aal1"), `${sql} aal1`).toBe(0);
    for (const s of readers) expect(await n(c, s, sql, "aal2"), `${sql} aal2 (control)`).toBeGreaterThan(0);
  }
  // other people's profiles are hidden too; the caller's OWN profile stays readable (currentUser() needs it to send staff to /mfa)
  expect(await n(c, w.psy, "select role from profiles", "aal1")).toBe(1);
  expect((await asUser(c, w.psy, () => c.query("select role::text from profiles where user_id=$1", [w.psy]), { aal: "aal1" })).rows[0].role).toBe("psychologist");
  expect(await n(c, w.psy, "select 1 from profiles", "aal2")).toBeGreaterThan(1);
}));

it("an aal1 staff session cannot write or call a staff function; aal2 can", () => withClient(async (c) => {
  const w = await world(c);
  const today = (await c.query("select sa_today()::text d")).rows[0].d as string;
  const st = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('S',50,100) returning id")).rows[0].id;
  const calls: [string, unknown[], string][] = [
    ["select record_payment($1,'cash',100,null,null)", [w.inv], "forbidden"],
    ["select invite_patient($1)", [w.lone], "forbidden"],
    ["select * from report_income_by_month($1::date,$1::date)", [today], "forbidden"],
    ["select * from report_debtors_detail($1::date)", [today], "forbidden"],
    ["select * from dashboard_payments_by_method($1::date,$1::date)", [today], "forbidden"],
    ["select * from credit_note_details($1)", [w.inv], "forbidden"],
    ["select book_appointment($1,$2,now() + interval '3 days')", [w.p, st], "forbidden"],
  ];
  for (const s of [w.psy, w.adm])
    for (const [sql, params, err] of calls) await expect(asUser(c, s, () => c.query(sql, params), { aal: "aal1" }), sql).rejects.toThrow(new RegExp(err));
  for (const [sql, params, err] of [["select * from report_income_by_month($1::date,$1::date)", [today], "forbidden"], ["select record_payment($1,'cash',100,null,null)", [w.inv], "forbidden"]] as const)
    await expect(asUser(c, w.bk, () => c.query(sql, [...params]), { aal: "aal1" }), sql).rejects.toThrow(new RegExp(err));
  // writes through the policies change nothing
  expect(await n(c, w.adm, "update patients set first_name='Z' where id=$1", "aal1", [w.p])).toBe(0);
  await expect(asUser(c, w.adm, () => c.query("insert into patients(first_name,last_name) values ('N','N')"), { aal: "aal1" })).rejects.toThrow(/row-level security/);
  expect(await n(c, w.psy, "update clinical_notes set content='{\"notes\":\"y\"}'", "aal1")).toBe(0);
  // the same calls with aal2 work (controls)
  await asUser(c, w.adm, () => c.query("select record_payment($1,'cash',100,null,null)", [w.inv]));
  await asUser(c, w.adm, () => c.query("select invite_patient($1)", [w.lone]));
  await asUser(c, w.bk, () => c.query("select * from report_income_by_month($1::date,$1::date)", [today]));
  expect(await n(c, w.adm, "update patients set first_name='Z' where id=$1", "aal2", [w.p])).toBe(1);
}));

it("patients are unaffected: an aal1 patient reads their own record, form, invoice and can submit through their functions", () => withClient(async (c) => {
  const w = await world(c);
  await c.query("update invoices set status='issued' where id=$1", [w.inv]);
  expect(await n(c, w.u, "select 1 from patients where id=$1", "aal1", [w.p])).toBe(1);
  expect(await n(c, w.u, "select 1 from form_submissions where patient_id=$1", "aal1", [w.p])).toBe(1);
  expect(await n(c, w.u, "select 1 from invoices where id=$1", "aal1", [w.inv])).toBe(1);
  expect(await n(c, w.u, "select 1 from clinical_notes", "aal1")).toBe(0);
  await asUser(c, w.u, () => c.query("select accept_booking_terms($1)", [w.p]), { aal: "aal1" });
  expect((await c.query("select granted from consents where patient_id=$1 and purpose='financial_terms'", [w.p])).rows[0].granted).toBe(true);
}));
