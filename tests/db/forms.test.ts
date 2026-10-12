import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, asService, mkUser } from "./helpers";

// Task 11b (0012): a patient or guardian can only SUBMIT through submit_form(), and can only GRANT a consent that a submitted form of theirs backs.
// So these tests grant consents as staff, or through a submitted form whose template declares the purpose (SCHEMA_ALL does, for every purpose).
const PURPOSES = ["treatment", "privacy_notice", "telehealth", "financial_terms", "share_referrer", "share_insurer"];
const SCHEMA_ALL = { fields: PURPOSES.map((p) => ({ key: "c_" + p, label: p, type: "checkbox", consentPurpose: p })) };
const submitAs = (c: Client, u: string, id: string, answers: object = {}) =>
  asUser(c, u, () => c.query("select submit_form($1,$2::jsonb,'{}'::text[])", [id, JSON.stringify(answers)]));

/** staff of every kind, two patients with their own users, and an active template reg v1 */
async function seed(c: Client) {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), bk = await mkUser(c, "bookkeeper");
  const u1 = await mkUser(c, "patient"), u2 = await mkUser(c, "patient");
  const p1 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u1])).rows[0].id as string;
  const p2 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','B') returning id", [u2])).rows[0].id as string;
  const t = (await c.query("insert into form_templates(key,version,schema) values ('reg',1,$1) returning id", [JSON.stringify(SCHEMA_ALL)])).rows[0].id as string;
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
  const u = await mkUser(c, "patient"), psy = await mkUser(c, "psychologist");
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u])).rows[0].id;
  await asUser(c, psy, () => c.query("select set_consent($1,'telehealth',true,null)", [p]));
  await asUser(c, u, () => c.query("select set_consent($1,'telehealth',false,null)", [p])); // the patient withdraws without a form
  const t = await c.query("select 1 from tasks where patient_id=$1 and source='consent_withdrawn'", [p]);
  expect(t.rowCount).toBe(1);
}));

// ---- role matrix ---------------------------------------------------------------------------------------------------
it("form_submissions / consents / tasks read matrix", () => withClient(async (c) => {
  const { psy, adm, bk, u1, u2, p1, t } = await seed(c);
  const gYes = await guardian(c, p1, '{"forms":true}'), gNo = await guardian(c, p1, '{"book":true,"forms":false}');
  const gOld = await guardian(c, p1, '{"forms":true}', "2000-01-01");
  await mkSub(c, p1, t);
  await asUser(c, psy, () => c.query("select set_consent($1,'treatment',true,null)", [p1]));
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
  await expect(upd("status='bogus'")).rejects.toThrow(/invalid_status_transition/);
  expect((await sub(c, id)).submitted_at).toBeNull();
  await expect(upd("status='submitted'")).rejects.toThrow(/use_submit_form/); // a plain UPDATE cannot submit (0012)
  expect((await sub(c, id)).status).toBe("draft");
  await submitAs(c, u1, id, { a: 1 });
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
  await submitAs(c, u1, id, { a: 1 });
  await asUser(c, psy, async () => {
    await expect(c.query("update form_submissions set answers='{\"a\":9}' where id=$1", [id])).rejects.toThrow(/submission is immutable/);
    await expect(c.query("update form_submissions set status='draft' where id=$1", [id])).rejects.toThrow(/submission is immutable/);
    await expect(c.query("update form_submissions set submitted_at=null where id=$1", [id])).rejects.toThrow(/submission is immutable/);
    await c.query("update form_submissions set status='returned', return_note='fix it' where id=$1", [id]);
  });
  expect((await sub(c, id)).status).toBe("returned");
  expect((await c.query("select action, actor_id from audit_log where entity_id=$1 order by id", [id])).rows).toEqual([{ action: "form.submit", actor_id: u1 }, { action: "form.return", actor_id: psy }]);
  await asUser(c, u1, async () => {
    await c.query(`update form_submissions set answers='{"a":2}' where id=$1`, [id]); // returned -> returned
    await c.query("select submit_form($1,'{\"a\":2}'::jsonb,'{}'::text[])", [id]);
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
    await c.query("select submit_form($1,'{\"g\":1}'::jsonb,'{}'::text[])", [id]);
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
  const { psy, p1 } = await seed(c);
  await asUser(c, psy, () => c.query("select set_consent($1,'treatment',true,null)", [p1]));
  expect((await c.query("select purpose from consents where patient_id=$1", [p1])).rows).toEqual([{ purpose: "treatment" }]);
  await asUser(c, psy, () => c.query("select set_consent($1,'share_insurer',true,null)", [p1]));
  expect((await c.query("select purpose from consents where patient_id=$1 order by purpose", [p1])).rows.map((r) => r.purpose)).toEqual(["share_insurer", "treatment"]);
}));

it("set_consent: forbidden for other patients, bookkeeper, guardian without forms; staff may grant; patient and guardian only through a submitted form", () => withClient(async (c) => {
  const { psy, adm, bk, u1, u2, p1, t } = await seed(c);
  const yes = await guardian(c, p1, '{"forms":true}'), no = await guardian(c, p1, '{"book":true,"forms":false}');
  const set = (u: string, s: string | null = null) => asUser(c, u, () => c.query("select set_consent($1,'treatment',true,$2)", [p1, s]));
  for (const u of [u2, bk, no]) await expect(set(u)).rejects.toThrow(/forbidden/);
  expect((await c.query("select 1 from consents")).rowCount).toBe(0);
  // without a submission the patient and the guardian cannot grant (the only door is submitting the form)
  for (const u of [u1, yes]) await expect(set(u)).rejects.toThrow(/consent_needs_submission/);
  expect((await c.query("select 1 from consents")).rowCount).toBe(0);
  for (const u of [psy, adm]) await set(u);
  expect((await consent(c, p1, "treatment")).granted).toBe(true);
  // with a submitted form of theirs that declares the purpose they can (an unrelated purpose is refused below)
  const mine = await mkSub(c, p1, t, "submitted");
  for (const u of [u1, yes]) await set(u, mine);
  const noDecl = (await c.query("insert into form_templates(key,version,schema) values ('other',1,'{\"fields\":[]}') returning id")).rows[0].id as string;
  const sub2 = await mkSub(c, p1, noDecl, "submitted");
  await expect(asUser(c, u1, () => c.query("select set_consent($1,'telehealth',true,$2)", [p1, sub2]))).rejects.toThrow(/consent_not_in_template/);
  // withdrawing needs no form, for the patient and the guardian with forms
  await asUser(c, u1, () => c.query("select set_consent($1,'treatment',false,null)", [p1]));
  expect((await consent(c, p1, "treatment")).granted).toBe(false);
}));

it("set_consent validates purpose and the submission", () => withClient(async (c) => {
  const { u1, p1, p2, t } = await seed(c);
  const other = await mkSub(c, p2, t, "submitted"), mine = await mkSub(c, p1, t, "submitted"), draft = await mkSub(c, p1, t);
  const set = (p: string, purpose: string, s: string | null) => asUser(c, u1, () => c.query("select set_consent($1,$2,true,$3)", [p, purpose, s]));
  await expect(set(p1, "marketing", null)).rejects.toThrow(/invalid_purpose/);
  await expect(set(p1, "treatment", other)).rejects.toThrow(/submission_mismatch/);
  await expect(set(p1, "treatment", draft)).rejects.toThrow(/submission_not_submitted/);
  await expect(set(p1, "treatment", "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/submission_mismatch/);
  expect((await c.query("select 1 from consents")).rowCount).toBe(0);
  await set(p1, "treatment", mine);
  const r = await consent(c, p1, "treatment");
  expect(r.form_submission_id).toBe(mine);
  expect(r.template_version).toBe(1);
}));

it("withdrawal creates exactly one task; repeat withdrawal and withdrawing a never-granted purpose create none", () => withClient(async (c) => {
  const { psy, u1, p1 } = await seed(c);
  const w = (granted: boolean, purpose = "telehealth") => asUser(c, granted ? psy : u1, () => c.query("select set_consent($1,$2,$3,null)", [p1, purpose, granted]));
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
  const { psy, p1 } = await seed(c);
  const w = (granted: boolean) => asUser(c, psy, () => c.query("select set_consent($1,'treatment',$2,null)", [p1, granted]));
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

it("set_consent audit detail records the change, previous state and acting role", () => withClient(async (c) => {
  const { psy, u1, p1, t } = await seed(c);
  const t2 = (await c.query("insert into form_templates(key,version,schema) values ('reg',2,$1) returning id", [JSON.stringify(SCHEMA_ALL)])).rows[0].id;
  const s1 = await mkSub(c, p1, t, "submitted"), s2 = await mkSub(c, p1, t2, "submitted");
  const set = (u: string, g: boolean, s: string | null) => asUser(c, u, () => c.query("select set_consent($1,'treatment',$2,$3)", [p1, g, s]));
  const audit = async () => (await c.query("select action, actor_id, entity_id, detail from audit_log where entity='consents' order by id")).rows;
  await set(u1, true, s1);
  await c.query("update consents set granted_at='2020-01-01T00:00:00Z' where patient_id=$1", [p1]);
  await set(u1, true, s1); // same evidence: nothing changes
  expect((await consent(c, p1, "treatment")).granted_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  await set(psy, true, s2); // new template version: fresh agreement
  let r = await consent(c, p1, "treatment");
  expect([r.template_version, r.form_submission_id, r.granted, r.withdrawn_at]).toEqual([2, s2, true, null]);
  expect(r.granted_at.toISOString()).not.toBe("2020-01-01T00:00:00.000Z");
  await set(u1, false, null); // withdrawal keeps the evidence of what was agreed
  r = await consent(c, p1, "treatment");
  expect([r.template_version, r.form_submission_id, r.granted]).toEqual([2, s2, false]);
  expect(r.withdrawn_at).not.toBeNull();
  const a = await audit();
  expect(a.map((x) => [x.action, x.actor_id, x.entity_id])).toEqual([
    ["consent.grant", u1, p1], ["consent.grant", u1, p1], ["consent.grant", psy, p1], ["consent.withdraw", u1, p1]]);
  const d = a.map((x) => x.detail);
  expect(d[0]).toMatchObject({ purpose: "treatment", granted: true, template_version: 1, form_submission_id: s1, previous_granted: null,
    previous_granted_at: null, previous_withdrawn_at: null, acted_by_role: "patient" });
  expect(d[2]).toMatchObject({ granted: true, template_version: 2, form_submission_id: s2, previous_granted: true, acted_by_role: "psychologist" });
  expect(new Date(d[2].previous_granted_at).toISOString()).toBe("2020-01-01T00:00:00.000Z");
  expect(d[2].previous_withdrawn_at).toBeNull();
  expect(d[3]).toMatchObject({ purpose: "treatment", granted: false, template_version: 2, form_submission_id: s2, previous_granted: true,
    previous_withdrawn_at: null, acted_by_role: "patient" });
  expect(d[3].previous_granted_at).not.toBeNull();
  // re-grant after withdrawal: evidence and timestamps are consistent again, previous state recorded
  await set(u1, true, s2);
  r = await consent(c, p1, "treatment");
  expect([r.granted, r.withdrawn_at, r.template_version, r.form_submission_id]).toEqual([true, null, 2, s2]);
  const last = (await audit()).at(-1)!.detail;
  expect(last).toMatchObject({ granted: true, previous_granted: false });
  expect(last.previous_withdrawn_at).not.toBeNull();
}));

it("consents cannot be written directly by patients, guardians or staff, and are never deleted", () => withClient(async (c) => {
  const { psy, adm, u1, p1 } = await seed(c);
  const g = await guardian(c, p1, '{"forms":true}');
  await asUser(c, psy, () => c.query("select set_consent($1,'treatment',true,null)", [p1]));
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
    const denied = /permission denied for table notifications_outbox/;
    await expect(count(c, u, "notifications_outbox")).rejects.toThrow(denied);
    await expect(asUser(c, u, () => c.query("insert into notifications_outbox(channel,template,recipient) values ('email','x','y')"))).rejects.toThrow(denied);
    await expect(asUser(c, u, () => c.query("update notifications_outbox set status='sent'"))).rejects.toThrow(denied);
    await expect(asUser(c, u, () => c.query("delete from notifications_outbox"))).rejects.toThrow(denied);
  }
  expect((await c.query("select 1 from notifications_outbox where status='pending'")).rowCount).toBe(1);
  await expect(c.query("insert into notifications_outbox(channel,template,recipient) values ('fax','x','y')")).rejects.toThrow(/check constraint/);
}));

it("retention_policies are psychologist-only", () => withClient(async (c) => {
  const { psy, adm, bk, u1, p1 } = await seed(c);
  const g = await guardian(c, p1, '{"forms":true}');
  await asUser(c, psy, () => c.query("insert into retention_policies(record_type,retain_years) values ('test_records',6)"));
  expect(await count(c, psy, "retention_policies")).toBe(6); // the five default rows of 0027 plus this one
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

// ---- fix round 1: evidence protection ---------------------------------------------------------------------------------
it("form_submissions can never be deleted", () => withClient(async (c) => {
  const { psy, adm, u1, p1, t } = await seed(c);
  const id = await mkSub(c, p1, t);
  for (const u of [psy, adm, u1])
    await expect(asUser(c, u, () => c.query("delete from form_submissions where id=$1", [id]))).rejects.toThrow(/permission denied for table form_submissions/);
  await expect(asService(c, () => c.query("delete from form_submissions"))).rejects.toThrow(/permission denied for table form_submissions/);
  await expect(c.query("delete from form_submissions where id=$1", [id])).rejects.toThrow(/form_submissions cannot be deleted/); // owner too
  expect((await c.query("select 1 from form_submissions where id=$1", [id])).rowCount).toBe(1);
}));

it("submission attribution: DB stamps submitted_by/submitted_at and audits every submit once", () => withClient(async (c) => {
  const { psy, u1, p1, p2, t } = await seed(c);
  const audit = async (id: string) => (await c.query("select action, actor_id, entity, detail from audit_log where entity_id=$1 and action='form.submit'", [id])).rows;
  // staff submits a draft on the patient's behalf (a caller-supplied timestamp is ignored)
  const a = await mkSub(c, p1, t);
  await asUser(c, psy, () => c.query("update form_submissions set status='submitted', submitted_at='2000-01-01' where id=$1", [a]));
  expect((await sub(c, a)).submitted_by).toBe(psy);
  expect((await c.query("select submitted_at = now() as ok from form_submissions where id=$1", [a])).rows[0].ok).toBe(true);
  expect(await audit(a)).toEqual([{ action: "form.submit", actor_id: psy, entity: "form_submissions", detail: { patient_id: p1, template_id: t, template_version: 1 } }]);
  // patient submit
  const b = await mkSub(c, p2, t);
  const u2 = (await c.query("select user_id from patients where id=$1", [p2])).rows[0].user_id;
  await submitAs(c, u2, b);
  expect((await sub(c, b)).submitted_by).toBe(u2);
  expect((await audit(b)).map((r) => r.actor_id)).toEqual([u2]);
  // staff cannot backdate on insert, nor smuggle a timestamp into a draft
  const ins = (status: string) => asUser(c, psy, () => c.query("insert into form_submissions(patient_id,template_id,template_version,status,submitted_at) values ($1,$2,1,$3,'2000-01-01') returning id", [p1, t, status]));
  const d = (await ins("submitted")).rows[0].id;
  expect((await c.query("select submitted_at = now() as ok, submitted_by from form_submissions where id=$1", [d])).rows[0]).toEqual({ ok: true, submitted_by: psy });
  expect((await audit(d)).length).toBe(1);
  const e = (await ins("draft")).rows[0].id;
  expect(await sub(c, e)).toMatchObject({ submitted_at: null, submitted_by: null });
  // submitted_by is frozen outside a submit
  await expect(c.query("update form_submissions set submitted_by=$2 where id=$1", [e, u1])).rejects.toThrow(/protected submission columns/);
  // resubmission after a return is a new, audited transition by the resubmitter
  await asUser(c, psy, () => c.query("update form_submissions set status='returned', return_note='fix it' where id=$1", [b]));
  expect((await sub(c, b)).submitted_by).toBe(u2);
  await submitAs(c, u2, b);
  expect((await audit(b)).length).toBe(2);
}));

it("every submission is snapshotted: submit, return, edit, resubmit keeps both versions; snapshots are append-only", () => withClient(async (c) => {
  const { psy, bk, u1, u2, p1, t } = await seed(c);
  const gNo = await guardian(c, p1, '{"forms":false}'), gYes = await guardian(c, p1, '{"forms":true}');
  const id = await mkSub(c, p1, t);
  const snaps = async () => (await c.query("select event, answers, template_version, actor from form_submission_versions where submission_id=$1 order by id", [id])).rows;
  await asUser(c, u1, () => c.query(`update form_submissions set answers='{"v":1}' where id=$1`, [id]));
  expect(await snaps()).toEqual([]); // drafts are not snapshotted
  await submitAs(c, u1, id, { v: 1 });
  await asUser(c, psy, () => c.query("update form_submissions set status='returned', return_note='fix it' where id=$1", [id]));
  await asUser(c, u1, () => c.query(`update form_submissions set answers='{"v":2}' where id=$1`, [id]));
  expect((await snaps()).length).toBe(1); // editing a returned form does not snapshot
  await submitAs(c, u1, id, { v: 2 });
  expect(await snaps()).toEqual([
    { event: "submitted", answers: { v: 1 }, template_version: 1, actor: u1 },
    { event: "submitted", answers: { v: 2 }, template_version: 1, actor: u1 }]);
  // an insert-as-submitted by staff is snapshotted too
  const id2 = (await c.query(`insert into form_submissions(patient_id,template_id,template_version,status,answers) values ($1,$2,1,'submitted','{"z":1}') returning id`, [p1, t])).rows[0].id;
  expect((await c.query("select answers from form_submission_versions where submission_id=$1", [id2])).rows).toEqual([{ answers: { z: 1 } }]);
  // reads: staff and the owning patient / forms guardian only
  const m: [string, string, number][] = [[psy, "psychologist", 3], [u1, "patient", 3], [gYes, "guardian forms=true", 3], [u2, "other patient", 0], [bk, "bookkeeper", 0], [gNo, "guardian forms=false", 0]];
  for (const [u, who, n] of m) expect(await count(c, u, "form_submission_versions"), who).toBe(n);
  // append-only
  await expect(c.query("update form_submission_versions set answers='{}'")).rejects.toThrow(/form_submission_versions is append-only/);
  await expect(c.query("delete from form_submission_versions")).rejects.toThrow(/form_submission_versions is append-only/);
  for (const u of [psy, u1]) {
    for (const q of ["update form_submission_versions set answers='{}'", "delete from form_submission_versions", "insert into form_submission_versions(submission_id,event,answers,template_version) select id,'submitted','{}',1 from form_submissions"])
      await expect(asUser(c, u, () => c.query(q)), q).rejects.toThrow(/permission denied for table form_submission_versions/);
  }
  await expect(asService(c, () => c.query("delete from form_submission_versions"))).rejects.toThrow(/permission denied for table form_submission_versions/);
}));

it("expired guardian cannot set consent or write submissions; bookkeeper/associate cannot write submissions; admin can return", () => withClient(async (c) => {
  const { adm, bk, u1, p1, t } = await seed(c);
  const assoc = await mkUser(c, "associate");
  const old = await guardian(c, p1, '{"forms":true}', "2000-01-01");
  await expect(asUser(c, old, () => c.query("select set_consent($1,'treatment',true,null)", [p1]))).rejects.toThrow(/forbidden/);
  const id = await mkSub(c, p1, t);
  for (const u of [old, bk, assoc]) {
    await expect(asUser(c, u, () => c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1)", [p1, t]))).rejects.toThrow(/row-level security/);
    expect((await asUser(c, u, () => c.query(`update form_submissions set answers='{"x":1}' where id=$1`, [id]))).rowCount).toBe(0);
  }
  expect((await sub(c, id)).answers).toEqual({});
  // unknown template id on a patient insert
  await expect(asUser(c, u1, () => c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,gen_random_uuid(),1)", [p1]))).rejects.toThrow(/template_not_active/);
  // admin returns a submitted form, audited
  await submitAs(c, u1, id);
  await asUser(c, adm, () => c.query("update form_submissions set status='returned', return_note='fix it' where id=$1", [id]));
  expect((await sub(c, id)).status).toBe("returned");
  expect((await c.query("select actor_id, role from audit_log where entity_id=$1 and action='form.return'", [id])).rows).toEqual([{ actor_id: adm, role: "admin" }]);
}));
