import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, asService, mkUser } from "./helpers";

/** staff of every kind, two patients with their own users, and an active template reg v1 */
async function seed(c: Client) {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), bk = await mkUser(c, "bookkeeper");
  const u1 = await mkUser(c, "patient"), u2 = await mkUser(c, "patient");
  const p1 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u1])).rows[0].id as string;
  const p2 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','B') returning id", [u2])).rows[0].id as string;
  const t = (await c.query("insert into form_templates(key,version,schema) values ('reg',1,'{\"q\":1}') returning id")).rows[0].id as string;
  return { psy, adm, bk, u1, u2, p1, p2, t };
}
async function guardian(c: Client, patient: string, permissions: string, validTo: string | null = null) {
  const g = await mkUser(c, "guardian");
  await c.query("insert into guardianships(guardian_user_id,patient_id,permissions,valid_to) values ($1,$2,$3,$4)", [g, patient, permissions, validTo]);
  return g;
}
const count = (c: Client, u: string, table: string) => asUser(c, u, async () => (await c.query(`select 1 from ${table}`)).rowCount);
const mkSub = async (c: Client, p: string, t: string, status = "draft") =>
  (await c.query("insert into form_submissions(patient_id,template_id,template_version,status) values ($1,$2,1,$3) returning id", [p, t, status])).rows[0].id as string;
const sub = async (c: Client, id: string) => (await c.query("select * from form_submissions where id=$1", [id])).rows[0];
const consent = async (c: Client, p: string, purpose: string) =>
  (await c.query("select * from consents where patient_id=$1 and purpose=$2", [p, purpose])).rows[0];

// ---- brief tests -------------------------------------------------------------------------------------------------
it("patient sees only own submissions", () => withClient(async (c) => {
  const { u1, p1, p2, t } = await seed(c);
  await c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$3,1),($2,$3,1)", [p1, p2, t]);
  expect(await count(c, u1, "form_submissions")).toBe(1);
}));
it("withdrawing consent creates a task", () => withClient(async (c) => {
  const u = await mkUser(c, "patient");
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u])).rows[0].id;
  await asUser(c, u, async () => { await c.query("select set_consent($1,'telehealth',true,null)", [p]); await c.query("select set_consent($1,'telehealth',false,null)", [p]); });
  const t = await c.query("select 1 from tasks where patient_id=$1 and source='consent_withdrawn'", [p]);
  expect(t.rowCount).toBe(1);
}));

// ---- role matrix ---------------------------------------------------------------------------------------------------
it("form_submissions / consents / tasks read matrix", () => withClient(async (c) => {
  const { psy, adm, bk, u1, u2, p1, t } = await seed(c);
  const gYes = await guardian(c, p1, '{"forms":true}'), gNo = await guardian(c, p1, '{"book":true,"forms":false}');
  const gOld = await guardian(c, p1, '{"forms":true}', "2000-01-01");
  await mkSub(c, p1, t);
  await asUser(c, u1, () => c.query("select set_consent($1,'treatment',true,null)", [p1]));
  await c.query("insert into tasks(title) values ('x')");
  const m: [string, string, number, number, number][] = [ // user, label, submissions, consents, tasks
    [psy, "psychologist", 1, 1, 1], [adm, "admin", 1, 1, 1], [bk, "bookkeeper", 0, 0, 0],
    [u1, "patient", 1, 1, 0], [u2, "other patient", 0, 0, 0],
    [gYes, "guardian forms=true", 1, 1, 0], [gNo, "guardian forms=false", 0, 0, 0], [gOld, "expired guardian", 0, 0, 0]];
  for (const [u, who, s, co, tk] of m) {
    expect(await count(c, u, "form_submissions"), `${who} submissions`).toBe(s);
    expect(await count(c, u, "consents"), `${who} consents`).toBe(co);
    expect(await count(c, u, "tasks"), `${who} tasks`).toBe(tk);
  }
}));

it("tasks: only psychologist and admin may write; everyone else is rejected", () => withClient(async (c) => {
  const { psy, adm, bk, u1, p1 } = await seed(c);
  const g = await guardian(c, p1, '{"forms":true}');
  for (const u of [psy, adm]) await asUser(c, u, () => c.query("insert into tasks(title) values ('ok')"));
  for (const u of [bk, u1, g]) {
    await expect(asUser(c, u, () => c.query("insert into tasks(title) values ('no')"))).rejects.toThrow(/row-level security/);
    expect((await asUser(c, u, () => c.query("update tasks set status='done'"))).rowCount).toBe(0);
    expect((await asUser(c, u, () => c.query("delete from tasks"))).rowCount).toBe(0);
  }
  expect((await c.query("select 1 from tasks where status='done'")).rowCount).toBe(0);
}));

// ---- form_submissions guard ---------------------------------------------------------------------------------------
it("patient inserts: draft only, active template only, template_version forced", () => withClient(async (c) => {
  const { u1, u2, p1, p2, t } = await seed(c);
  const ins = (status: string, p = p1, tid = t, v = 99, extra = "") =>
    asUser(c, u1, () => c.query(`insert into form_submissions(patient_id,template_id,template_version,status${extra ? ",submitted_at" : ""}) values ($1,$2,$3,$4${extra ? ",now()" : ""}) returning id`, [p, tid, v, status]));
  await expect(ins("submitted")).rejects.toThrow(/created as a draft/);
  await expect(ins("returned")).rejects.toThrow(/created as a draft/);
  await expect(ins("draft", p1, t, 1, "x")).rejects.toThrow(/created as a draft/);
  await expect(ins("draft", p2)).rejects.toThrow(/row-level security/); // someone else's patient
  const id = (await ins("draft")).rows[0].id;
  expect((await sub(c, id)).template_version).toBe(1); // the claimed 99 is ignored
  await c.query("update form_templates set active=false where id=$1", [t]);
  await expect(ins("draft")).rejects.toThrow(/template_not_active/);
  await expect(asUser(c, u2, () => c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1)", [p2, t]))).rejects.toThrow(/template_not_active/);
}));

it("patient updates: identity columns frozen, status draft->submitted only, DB stamps submitted_at, submitted is immutable", () => withClient(async (c) => {
  const { u1, p1, p2, t } = await seed(c);
  const t2 = (await c.query("insert into form_templates(key,version,schema) values ('reg',2,'{}') returning id")).rows[0].id;
  const id = await mkSub(c, p1, t);
  const upd = (set: string, params: unknown[] = []) => asUser(c, u1, () => c.query(`update form_submissions set ${set} where id=$1`, [id, ...params]));
  for (const set of [`patient_id='${p2}'`, `template_id='${t2}'`, "template_version=2", "submitted_at=now()", "id=gen_random_uuid()"])
    await expect(upd(set), set).rejects.toThrow(/protected submission columns/);
  await upd(`answers='{"a":1}'`); // draft -> draft is fine
  await expect(upd("status='returned'")).rejects.toThrow(/invalid_status_transition/);
  await expect(upd("status='bogus'")).rejects.toThrow(); // check constraint
  expect((await sub(c, id)).submitted_at).toBeNull();
  await upd("status='submitted'");
  const s = await sub(c, id);
  expect(s.status).toBe("submitted");
  expect(s.submitted_at).not.toBeNull();
  // submitted: invisible to the update policy, so nothing changes
  expect((await upd(`answers='{"a":2}'`)).rowCount).toBe(0);
  expect((await upd("status='draft'")).rowCount).toBe(0);
  expect((await sub(c, id)).answers).toEqual({ a: 1 });
}));

it("staff may return a submitted form; the patient then edits and resubmits; submitted answers are frozen even for staff", () => withClient(async (c) => {
  const { psy, u1, p1, t } = await seed(c);
  const id = await mkSub(c, p1, t);
  await asUser(c, u1, () => c.query("update form_submissions set answers='{\"a\":1}', status='submitted' where id=$1", [id]));
  await asUser(c, psy, async () => {
    await expect(c.query("update form_submissions set answers='{\"a\":9}' where id=$1", [id])).rejects.toThrow(/submission is immutable/);
    await expect(c.query("update form_submissions set status='draft' where id=$1", [id])).rejects.toThrow(/submission is immutable/);
    await expect(c.query("update form_submissions set submitted_at=null where id=$1", [id])).rejects.toThrow(/protected submission columns|submission is immutable/);
    await c.query("update form_submissions set status='returned' where id=$1", [id]);
  });
  expect((await sub(c, id)).status).toBe("returned");
  expect((await c.query("select action, actor_id from audit_log where entity_id=$1", [id])).rows).toEqual([{ action: "form.return", actor_id: psy }]);
  await asUser(c, u1, async () => {
    await c.query(`update form_submissions set answers='{"a":2}' where id=$1`, [id]); // returned -> returned
    await c.query("update form_submissions set status='submitted' where id=$1", [id]);
  });
  const s = await sub(c, id);
  expect(s.status).toBe("submitted");
  expect(s.answers).toEqual({ a: 2 });
}));

it("updated_at is maintained by trigger", () => withClient(async (c) => {
  const { p1, t } = await seed(c);
  const id = await mkSub(c, p1, t);
  await c.query("update form_submissions set updated_at='2000-01-01' where id=$1", [id]);
  await c.query("update form_submissions set answers='{\"x\":1}' where id=$1", [id]);
  expect((await c.query("select updated_at = now() as ok from form_submissions where id=$1", [id])).rows[0].ok).toBe(true);
}));

it("guardian writes forms only with permissions.forms = true", () => withClient(async (c) => {
  const { p1, t } = await seed(c);
  const yes = await guardian(c, p1, '{"forms":true}'), no = await guardian(c, p1, '{"book":true,"forms":false}');
  const ins = (g: string) => asUser(c, g, () => c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1) returning id", [p1, t]));
  await expect(ins(no)).rejects.toThrow(/row-level security/);
  const id = (await ins(yes)).rows[0].id;
  await asUser(c, yes, async () => {
    await c.query(`update form_submissions set answers='{"g":1}' where id=$1`, [id]);
    await c.query("update form_submissions set status='submitted' where id=$1", [id]);
  });
  expect((await sub(c, id)).status).toBe("submitted");
  const id2 = await mkSub(c, p1, t);
  expect((await asUser(c, no, () => c.query(`update form_submissions set answers='{"g":1}' where id=$1`, [id2]))).rowCount).toBe(0);
  expect((await sub(c, id2)).answers).toEqual({});
}));

// ---- form_templates -------------------------------------------------------------------------------------------------
it("template schema and version are immutable once a submission references them; new versions are new rows", () => withClient(async (c) => {
  const { psy, bk, p1, t } = await seed(c);
  await asUser(c, psy, () => c.query(`update form_templates set schema='{"q":2}' where id=$1`, [t])); // unused so far: still editable
  await mkSub(c, p1, t);
  for (const set of [`schema='{"q":3}'`, "version=7", "key='other'"]) {
    await expect(asUser(c, psy, () => c.query(`update form_templates set ${set} where id=$1`, [t])), set).rejects.toThrow(/template_in_use/);
    await expect(c.query(`update form_templates set ${set} where id=$1`, [t]), `owner ${set}`).rejects.toThrow(/template_in_use/);
  }
  await asUser(c, psy, () => c.query("update form_templates set active=false where id=$1", [t])); // retiring is fine
  const v2 = await asUser(c, psy, () => c.query("insert into form_templates(key,version,schema) values ('reg',2,'{\"q\":4}') returning id"));
  expect(v2.rowCount).toBe(1);
  await expect(asUser(c, bk, () => c.query("insert into form_templates(key,version,schema) values ('x',1,'{}')"))).rejects.toThrow(/row-level security/);
}));

// ---- consents ---------------------------------------------------------------------------------------------------------
it("a freshly registered patient has zero consent rows (nothing is bundled)", () => withClient(async (c) => {
  const { u1, p1 } = await seed(c);
  expect((await c.query("select 1 from consents where patient_id=$1", [p1])).rowCount).toBe(0);
  expect(await count(c, u1, "consents")).toBe(0);
}));

it("consents are recorded separately per purpose", () => withClient(async (c) => {
  const { u1, p1 } = await seed(c);
  await asUser(c, u1, () => c.query("select set_consent($1,'treatment',true,null)", [p1]));
  expect((await c.query("select purpose from consents where patient_id=$1", [p1])).rows).toEqual([{ purpose: "treatment" }]);
  await asUser(c, u1, () => c.query("select set_consent($1,'share_insurer',true,null)", [p1]));
  expect((await c.query("select purpose from consents where patient_id=$1 order by purpose", [p1])).rows.map((r) => r.purpose)).toEqual(["share_insurer", "treatment"]);
}));

it("set_consent: forbidden for other patients, bookkeeper, guardian without forms; allowed for staff and guardian with forms", () => withClient(async (c) => {
  const { psy, adm, bk, u1, u2, p1 } = await seed(c);
  const yes = await guardian(c, p1, '{"forms":true}'), no = await guardian(c, p1, '{"book":true,"forms":false}');
  const set = (u: string) => asUser(c, u, () => c.query("select set_consent($1,'treatment',true,null)", [p1]));
  for (const u of [u2, bk, no]) await expect(set(u)).rejects.toThrow(/forbidden/);
  expect((await c.query("select 1 from consents")).rowCount).toBe(0);
  for (const u of [u1, yes, psy, adm]) await set(u);
  expect((await consent(c, p1, "treatment")).granted).toBe(true);
}));

it("set_consent validates purpose and the submission", () => withClient(async (c) => {
  const { u1, p1, p2, t } = await seed(c);
  const other = await mkSub(c, p2, t), mine = await mkSub(c, p1, t);
  const set = (p: string, purpose: string, s: string | null) => asUser(c, u1, () => c.query("select set_consent($1,$2,true,$3)", [p, purpose, s]));
  await expect(set(p1, "marketing", null)).rejects.toThrow(/invalid_purpose/);
  await expect(set(p1, "treatment", other)).rejects.toThrow(/submission_mismatch/);
  await expect(set(p1, "treatment", "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/submission_mismatch/);
  expect((await c.query("select 1 from consents")).rowCount).toBe(0);
  await set(p1, "treatment", mine);
  const r = await consent(c, p1, "treatment");
  expect(r.form_submission_id).toBe(mine);
  expect(r.template_version).toBe(1);
}));

it("withdrawal creates exactly one task; repeat withdrawal and withdrawing a never-granted purpose create none", () => withClient(async (c) => {
  const { u1, p1 } = await seed(c);
  const w = (granted: boolean, purpose = "telehealth") => asUser(c, u1, () => c.query("select set_consent($1,$2,$3,null)", [p1, purpose, granted]));
  const tasks = async () => (await c.query("select title, priority, source, assignee from tasks where patient_id=$1", [p1])).rows;
  await w(false, "share_referrer"); // nothing to withdraw
  expect(await tasks()).toEqual([]);
  await w(true); await w(false);
  expect(await tasks()).toEqual([{ title: "Consent withdrawn: telehealth", priority: "high", source: "consent_withdrawn", assignee: null }]);
  await w(false);
  expect((await tasks()).length).toBe(1);
  const r = await consent(c, p1, "telehealth");
  expect(r.granted).toBe(false);
  expect(r.withdrawn_at).not.toBeNull();
}));

it("granting twice is idempotent and keeps granted_at; re-granting after withdrawal clears withdrawn_at", () => withClient(async (c) => {
  const { u1, p1 } = await seed(c);
  const w = (granted: boolean) => asUser(c, u1, () => c.query("select set_consent($1,'treatment',$2,null)", [p1, granted]));
  await w(true);
  await c.query("update consents set granted_at='2020-01-01T00:00:00Z' where patient_id=$1", [p1]);
  await w(true);
  expect((await consent(c, p1, "treatment")).granted_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  expect((await c.query("select 1 from consents where patient_id=$1", [p1])).rowCount).toBe(1);
  await w(false);
  expect((await consent(c, p1, "treatment")).withdrawn_at).not.toBeNull();
  await w(true);
  const r = await consent(c, p1, "treatment");
  expect(r.granted).toBe(true);
  expect(r.withdrawn_at).toBeNull();
  expect(r.granted_at.toISOString()).not.toBe("2020-01-01T00:00:00.000Z"); // fresh grant
}));

it("set_consent writes an audit row", () => withClient(async (c) => {
  const { u1, p1 } = await seed(c);
  await asUser(c, u1, async () => { await c.query("select set_consent($1,'treatment',true,null)", [p1]); await c.query("select set_consent($1,'treatment',false,null)", [p1]); });
  const a = (await c.query("select action, actor_id, detail from audit_log where entity='consents' order by id")).rows;
  expect(a).toEqual([{ action: "consent.grant", actor_id: u1, detail: { purpose: "treatment" } },
                     { action: "consent.withdraw", actor_id: u1, detail: { purpose: "treatment" } }]);
}));

it("consents cannot be written directly by patients, guardians or staff, and are never deleted", () => withClient(async (c) => {
  const { psy, adm, u1, p1 } = await seed(c);
  const g = await guardian(c, p1, '{"forms":true}');
  await asUser(c, u1, () => c.query("select set_consent($1,'treatment',true,null)", [p1]));
  for (const u of [u1, g, psy, adm]) {
    await expect(asUser(c, u, () => c.query("insert into consents(patient_id,purpose,granted) values ($1,'telehealth',true)", [p1]))).rejects.toThrow(/permission denied for table consents/);
    await expect(asUser(c, u, () => c.query("update consents set granted=false where patient_id=$1", [p1]))).rejects.toThrow(/permission denied for table consents/);
    await expect(asUser(c, u, () => c.query("delete from consents where patient_id=$1", [p1]))).rejects.toThrow(/permission denied for table consents/);
  }
  await expect(asService(c, () => c.query("delete from consents"))).rejects.toThrow(/permission denied for table consents/);
  await expect(c.query("delete from consents")).rejects.toThrow(/consents cannot be deleted/); // even the owner
  expect((await consent(c, p1, "treatment")).granted).toBe(true);
}));

// ---- outbox / retention ------------------------------------------------------------------------------------------------
it("notifications_outbox is service-role only", () => withClient(async (c) => {
  const { psy, adm, bk, u1, p1 } = await seed(c);
  const g = await guardian(c, p1, '{"forms":true}');
  await asService(c, () => c.query("insert into notifications_outbox(channel,template,recipient) values ('email','welcome','a@b.test')"));
  expect((await asService(c, () => c.query("select 1 from notifications_outbox"))).rowCount).toBe(1);
  for (const u of [psy, adm, bk, u1, g]) {
    expect(await count(c, u, "notifications_outbox")).toBe(0);
    await expect(asUser(c, u, () => c.query("insert into notifications_outbox(channel,template,recipient) values ('email','x','y')"))).rejects.toThrow(/row-level security/);
    expect((await asUser(c, u, () => c.query("update notifications_outbox set status='sent'"))).rowCount).toBe(0);
    expect((await asUser(c, u, () => c.query("delete from notifications_outbox"))).rowCount).toBe(0);
  }
  expect((await c.query("select 1 from notifications_outbox where status='pending'")).rowCount).toBe(1);
  await expect(c.query("insert into notifications_outbox(channel,template,recipient) values ('fax','x','y')")).rejects.toThrow(/check constraint/);
}));

it("retention_policies are psychologist-only", () => withClient(async (c) => {
  const { psy, adm, bk, u1, p1 } = await seed(c);
  const g = await guardian(c, p1, '{"forms":true}');
  await asUser(c, psy, () => c.query("insert into retention_policies(record_type,retain_years) values ('clinical_notes',6)"));
  expect(await count(c, psy, "retention_policies")).toBe(1);
  for (const u of [adm, bk, u1, g]) {
    expect(await count(c, u, "retention_policies"), "read").toBe(0);
    await expect(asUser(c, u, () => c.query("insert into retention_policies(record_type) values ('x')"))).rejects.toThrow(/row-level security/);
    expect((await asUser(c, u, () => c.query("update retention_policies set legal_hold=true"))).rowCount).toBe(0);
  }
}));

it("the new tables have RLS enabled and anon has no access", () => withClient(async (c) => {
  const { rows } = await c.query(
    "select relname from pg_class where relname in ('form_templates','form_submissions','consents','tasks','notifications_outbox','retention_policies') and not relrowsecurity");
  expect(rows).toEqual([]);
  await c.query("set local role anon");
  try { await expect(c.query("select 1 from form_templates")).rejects.toThrow(/permission denied/); }
  finally { await c.query("reset role"); }
}));
