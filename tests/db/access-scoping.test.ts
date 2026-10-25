import { it, expect } from "vitest";
import type { Client } from "pg";
import { asService, asUser, mkUser, withClient } from "./helpers";

// 0031 (final review I2, I3, M1, M2, M3).

const rows = async (c: Client, who: string, sql: string, params: unknown[] = []) => (await asUser(c, who, () => c.query(sql, params))).rows;

async function people(c: Client) {
  const psy = await mkUser(c, "psychologist", "Psy"), adm = await mkUser(c, "admin", "Adm"), bk = await mkUser(c, "bookkeeper", "Bk"), assoc = await mkUser(c, "associate", "Assoc");
  const u = await mkUser(c, "patient", "Pat"), g = await mkUser(c, "guardian", "Gua");
  const p = (await c.query("insert into patients(user_id,first_name,last_name,email) values ($1,'P','P','p@x.test') returning id", [u])).rows[0].id as string;
  return { psy, adm, bk, assoc, u, g, p };
}

// ---- I2 -------------------------------------------------------------------------------------------------------------------------------------------
it("I2: no API caller can change patients.user_id, staff and the service role included", () => withClient(async (c) => {
  const w = await people(c);
  const unlinked = (await c.query("insert into patients(first_name,last_name) values ('U','U') returning id")).rows[0].id as string;
  for (const s of [w.psy, w.adm]) {
    // the attack: point a record at the staff member's own login (null -> self, and someone else's -> self), then read it through the patient policies
    await expect(asUser(c, s, () => c.query("update patients set user_id=$2 where id=$1", [unlinked, s]))).rejects.toThrow(/patient_account_link_protected/);
    await expect(asUser(c, s, () => c.query("update patients set user_id=$2 where id=$1", [w.p, s]))).rejects.toThrow(/patient_account_link_protected/);
    await expect(asUser(c, s, () => c.query("update patients set user_id=null where id=$1", [w.p]))).rejects.toThrow(/patient_account_link_protected/);
  }
  await expect(asUser(c, w.u, () => c.query("update patients set user_id=$2 where id=$1", [w.p, w.g]))).rejects.toThrow(/patient_account_link_protected/);
  await expect(asService(c, () => c.query("update patients set user_id=$2 where id=$1", [unlinked, w.u]))).rejects.toThrow(/patient_account_link_protected/);
  expect((await c.query("select user_id from patients where id=$1", [unlinked])).rows[0].user_id).toBeNull();
  expect((await c.query("select user_id from patients where id=$1", [w.p])).rows[0].user_id).toBe(w.u);
  // staff still edit every other column, and the owner (migrations, SQL editor) may relink
  await asUser(c, w.adm, () => c.query("update patients set phone='000 1', status='active' where id=$1", [w.p]));
  await c.query("update patients set user_id=null where id=$1", [w.p]);
}));

it("I2: ensure_patient_record still links an invited, confirmed, single-match row, and deleting the account still unlinks it", () => withClient(async (c) => {
  const u = await mkUser(c, "patient", "Link Me");
  await c.query("update auth.users set email='link.me@x.test', email_confirmed_at=now() where id=$1", [u]);
  const row = (await c.query("insert into patients(first_name,last_name,email,portal_invited_at) values ('Link','Me','Link.Me@x.test',now()) returning id")).rows[0].id;
  const got = (await asUser(c, u, () => c.query("select ensure_patient_record() id"), { aal: "aal1" })).rows[0].id;
  expect(got).toBe(row);
  expect((await c.query("select user_id from patients where id=$1", [row])).rows[0].user_id).toBe(u);
  await c.query("delete from auth.users where id=$1", [u]); // ON DELETE SET NULL runs as the table owner (trusted)
  expect((await c.query("select user_id from patients where id=$1", [row])).rows[0].user_id).toBeNull();
}));

// ---- I3 -------------------------------------------------------------------------------------------------------------------------------------------
it("I3: psychologist and admin read every profile; bookkeeper and associate only staff profiles and their own; patients and guardians only their own", () => withClient(async (c) => {
  const w = await people(c);
  const all = [w.psy, w.adm, w.bk, w.assoc, w.u, w.g];
  const visible = async (who: string) => (await rows(c, who, "select user_id from profiles where user_id = any($1)", [all])).map((r) => r.user_id).sort();
  for (const s of [w.psy, w.adm]) expect(await visible(s)).toEqual([...all].sort());
  for (const s of [w.bk, w.assoc]) expect(await visible(s)).toEqual([w.psy, w.adm, w.bk, w.assoc].sort());
  expect(await visible(w.u)).toEqual([w.u]);
  expect(await visible(w.g)).toEqual([w.g]);
  // the billing page's "recorded by" lookup as the bookkeeper: a staff name resolves, a patient's does not
  expect(await rows(c, w.bk, "select display_name from profiles where user_id=$1", [w.adm])).toEqual([{ display_name: "Adm" }]);
  expect(await rows(c, w.bk, "select display_name from profiles where user_id=$1", [w.u])).toEqual([]);
}));

// ---- M3 -------------------------------------------------------------------------------------------------------------------------------------------
it("M3: the associate reads no patient, appointment, form or billing data", () => withClient(async (c) => {
  const w = await people(c);
  const st = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('S',50,100) returning id")).rows[0].id;
  await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,now()+interval '1 day',now()+interval '1 day 50 minutes')", [w.p, st]);
  await c.query("insert into invoices(patient_id,total_cents,patient_portion_cents) values ($1,100,100)", [w.p]);
  for (const t of ["patients", "appointments", "appointment_events", "invoices", "form_submissions", "consents", "clinical_notes", "tasks", "medical_aid_members", "claims"])
    expect((await rows(c, w.assoc, `select 1 from ${t}`)).length, t).toBe(0);
  expect((await rows(c, w.adm, "select 1 from patients")).length).toBeGreaterThan(0); // control
}));

// ---- M1 -------------------------------------------------------------------------------------------------------------------------------------------
it("M1: tasks, patients and guardianships cannot be deleted through the API; patients and tasks not even by the owner", () => withClient(async (c) => {
  const w = await people(c);
  await c.query("insert into guardianships(guardian_user_id,patient_id) values ($1,$2)", [w.g, w.p]);
  await c.query("insert into tasks(title,patient_id) values ('t',$1)", [w.p]);
  for (const s of [w.psy, w.adm])
    for (const t of ["tasks", "patients", "guardianships"])
      await expect(asUser(c, s, () => c.query(`delete from ${t}`)), `${t}`).rejects.toThrow(new RegExp(`permission denied for table ${t}`));
  for (const t of ["tasks", "patients", "guardianships"])
    await expect(asService(c, () => c.query(`delete from ${t}`)), `service ${t}`).rejects.toThrow(new RegExp(`permission denied for table ${t}`));
  await expect(c.query("delete from tasks")).rejects.toThrow(/tasks cannot be deleted/);
  await expect(c.query("delete from patients where id=$1", [w.p])).rejects.toThrow(/patients cannot be deleted/);
  // a guardianship is ENDED, not deleted: with valid_to in the past the guardian loses access
  expect((await rows(c, w.g, "select id from patients")).length).toBe(1);
  await c.query("update guardianships set valid_to = current_date - 1 where guardian_user_id=$1", [w.g]);
  expect((await rows(c, w.g, "select id from patients")).length).toBe(0);
  // deleting the account in Supabase Auth (an owner action) still cascades to the guardianship and the profile
  await c.query("delete from auth.users where id=$1", [w.g]);
  expect((await c.query("select count(*)::int n from guardianships where guardian_user_id=$1", [w.g])).rows[0].n).toBe(0);
  expect((await c.query("select count(*)::int n from profiles where user_id=$1", [w.g])).rows[0].n).toBe(0);
}));

// ---- M2 -------------------------------------------------------------------------------------------------------------------------------------------
it("M2: an appointment's patient and session type are frozen for API roles; reschedule still makes a new row", () => withClient(async (c) => {
  const w = await people(c);
  const p2 = (await c.query("insert into patients(first_name,last_name) values ('Q','Q') returning id")).rows[0].id;
  const st = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('S',50,100) returning id")).rows[0].id;
  const st2 = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('T',50,200) returning id")).rows[0].id;
  const a = (await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,now()+interval '3 days',now()+interval '3 days 50 minutes') returning id", [w.p, st])).rows[0].id;
  for (const s of [w.psy, w.adm]) {
    await expect(asUser(c, s, () => c.query("update appointments set patient_id=$2 where id=$1", [a, p2]))).rejects.toThrow(/appointment_link_frozen/);
    await expect(asUser(c, s, () => c.query("update appointments set session_type_id=$2 where id=$1", [a, st2]))).rejects.toThrow(/appointment_link_frozen/);
  }
  await expect(asService(c, () => c.query("update appointments set patient_id=$2 where id=$1", [a, p2]))).rejects.toThrow(/appointment_link_frozen/);
  const moved = (await asUser(c, w.psy, () => c.query("select reschedule_appointment($1, now()+interval '4 days') id", [a]))).rows[0].id;
  expect((await c.query("select patient_id, session_type_id from appointments where id=$1", [moved])).rows[0]).toEqual({ patient_id: w.p, session_type_id: st });
  await asUser(c, w.adm, () => c.query("update appointments set status='confirmed' where id=$1", [moved])); // other columns stay editable
}));

it("M2: a draft invoice's patient and appointment cannot be changed through the API; save_invoice_draft still works", () => withClient(async (c) => {
  const w = await people(c);
  const p2 = (await c.query("insert into patients(first_name,last_name) values ('Q','Q') returning id")).rows[0].id;
  const st = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('S',50,100) returning id")).rows[0].id;
  const ap = (await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,now()-interval '2 days',now()-interval '2 days'+interval '50 minutes','attended') returning id", [w.p, st])).rows[0].id;
  const lines = JSON.stringify([{ description: "Session", quantity: 1, unit_cents: 100 }]);
  const inv = (await asUser(c, w.adm, () => c.query("select create_invoice_draft($1,$2,null,current_date+14,'self',100,0,0,100,0,100,$3::jsonb) id", [w.p, ap, lines]))).rows[0].id;
  for (const s of [w.psy, w.adm]) {
    await expect(asUser(c, s, () => c.query("update invoices set patient_id=$2 where id=$1", [inv, p2]))).rejects.toThrow(/invoice_link_frozen/);
    await expect(asUser(c, s, () => c.query("update invoices set appointment_id=null where id=$1", [inv]))).rejects.toThrow(/invoice_link_frozen/);
  }
  await asUser(c, w.adm, () => c.query("select save_invoice_draft($1,current_date+7,'self',200,0,0,200,0,200,$2::jsonb)", [inv, JSON.stringify([{ description: "Session", quantity: 2, unit_cents: 100 }])]));
  expect((await c.query("select patient_id, appointment_id, total_cents from invoices where id=$1", [inv])).rows[0]).toEqual({ patient_id: w.p, appointment_id: ap, total_cents: 200 });
}));
