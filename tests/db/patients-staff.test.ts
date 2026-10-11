import { it, expect } from "vitest";
import { asUser, asService, mkUser, withClient } from "./helpers";

// What app/app/patients/actions.ts relies on, checked against the real policies and triggers (no new migration needed).

it("psychologist and admin can add, edit, archive and flag patients; associate and bookkeeper cannot write", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), assoc = await mkUser(c, "associate"), bk = await mkUser(c, "bookkeeper");
  for (const u of [psy, adm]) {
    const id = (await asUser(c, u, () => c.query(
      "insert into patients(first_name,last_name,email,phone,emergency_contact,status,is_minor) values ('A','B','a@b.test','+27821234567','{\"name\":\"X\",\"phone\":\"+27835550000\"}','prospect',false) returning id"))).rows[0].id;
    await asUser(c, u, () => c.query("update patients set status='archived', is_minor=true, referral_source='GP', portal_invited_at=now(), comms_prefs='{\"email\":false,\"sms\":true}' where id=$1", [id]));
    const row = (await c.query("select status,is_minor,referral_source,portal_invited_at,comms_prefs from patients where id=$1", [id])).rows[0];
    expect(row).toMatchObject({ status: "archived", is_minor: true, referral_source: "GP", comms_prefs: { email: false, sms: true } });
    expect(row.portal_invited_at).not.toBeNull();
  }
  const id = (await c.query("insert into patients(first_name,last_name) values ('C','D') returning id")).rows[0].id;
  expect((await asUser(c, assoc, () => c.query("select 1 from patients"))).rowCount).toBe(3); // may read all
  expect((await asUser(c, assoc, () => c.query("update patients set referral_source='x' where id=$1", [id]))).rowCount).toBe(0); // RLS: no row visible to update
  await expect(asUser(c, assoc, () => c.query("insert into patients(first_name,last_name) values ('E','F')"))).rejects.toThrow(/row-level security/);
  expect((await asUser(c, bk, () => c.query("select 1 from patients"))).rowCount).toBe(0);
}));

it("the patient audit tab: only the psychologist reads rows by entity id, newest first, and rows come only from audit_append", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin");
  const id = (await c.query("insert into patients(first_name,last_name) values ('A','B') returning id")).rows[0].id;
  const other = (await c.query("insert into patients(first_name,last_name) values ('C','D') returning id")).rows[0].id;
  for (const [action, entity] of [["patient.create", id], ["patient.view", id], ["patient.update", id], ["patient.view", other]] as const)
    await asService(c, () => c.query("select audit_append($1,'psychologist',$2,'patients',$3,$4)", [psy, action, entity, JSON.stringify({ fields: ["email"] })]));
  const rows = (await asUser(c, psy, () => c.query("select action from audit_log where entity_id=$1 order by id desc", [id]))).rows;
  expect(rows.map((r) => r.action)).toEqual(["patient.update", "patient.view", "patient.create"]);
  expect((await asUser(c, adm, () => c.query("select 1 from audit_log where entity_id=$1", [id]))).rowCount).toBe(0);
  await expect(asUser(c, psy, () => c.query("select audit_append($1,'psychologist','x','patients',$2,null)", [psy, id]))).rejects.toThrow(/permission denied/);
}));

it("duplicate look-ups: escaped LIKE matches an email with an underscore only literally; phone spellings and date of birth find the row", () => withClient(async (c) => {
  await c.query("insert into patients(first_name,last_name,email,phone,date_of_birth) values ('A','B','jo_hn@x.test','0821234567','1990-05-01'), ('C','D','joXhn@x.test','+27835550000',null)");
  const emails = async (pattern: string) => (await c.query("select email from patients where email ilike $1", [pattern])).rows.map((r) => r.email as string).sort();
  expect(await emails("jo\\_hn@x.test")).toEqual(["jo_hn@x.test"]); // escapeLike output
  expect(await emails("jo_hn@x.test")).toEqual(["joXhn@x.test", "jo_hn@x.test"].sort()); // unescaped, the underscore would be a wildcard
  expect((await c.query("select 1 from patients where phone = any($1)", [["+27821234567", "0821234567", "27821234567"]])).rowCount).toBe(1);
  expect((await c.query("select 1 from patients where date_of_birth='1990-05-01'")).rowCount).toBe(1);
}));
