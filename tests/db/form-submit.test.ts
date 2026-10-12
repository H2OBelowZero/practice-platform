import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

// Task 11b (0012_form_submit.sql): submit_form, return_note, answers cap, restricted templates.

const SCHEMA = {
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "consent_treatment", label: "I consent", type: "checkbox", required: true, consentPurpose: "treatment" },
    { key: "share_referrer", label: "Share", type: "checkbox", consentPurpose: "share_referrer" },
  ],
};

async function seed(c: Client, schema: object = SCHEMA) {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), bk = await mkUser(c, "bookkeeper");
  const u1 = await mkUser(c, "patient"), u2 = await mkUser(c, "patient");
  const p1 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u1])).rows[0].id as string;
  const p2 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','B') returning id", [u2])).rows[0].id as string;
  const t = (await c.query("insert into form_templates(key,version,schema) values ('consent',3,$1) returning id", [JSON.stringify(schema)])).rows[0].id as string;
  return { psy, adm, bk, u1, u2, p1, p2, t };
}
const draft = async (c: Client, p: string, t: string) =>
  (await c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1) returning id", [p, t])).rows[0].id as string;
async function guardian(c: Client, patient: string, permissions: string) {
  const g = await mkUser(c, "guardian");
  await c.query("insert into guardianships(guardian_user_id,patient_id,permissions) values ($1,$2,$3)", [g, patient, permissions]);
  return g;
}
const ANSWERS = { name: "Ann", consent_treatment: true, share_referrer: false };
const submit = (c: Client, u: string, id: string, answers: unknown = ANSWERS, purposes: string[] | null = ["treatment"]) =>
  asUser(c, u, () => c.query("select submit_form($1, $2::jsonb, $3::text[])", [id, JSON.stringify(answers), purposes]));
const sub = async (c: Client, id: string) => (await c.query("select * from form_submissions where id=$1", [id])).rows[0];
const auditActions = async (c: Client, id: string) => (await c.query("select action, actor_id from audit_log where entity_id=$1 order by id", [id])).rows;

it("submit_form: answers stored, submitted, consents granted with the template version, one audit row, one snapshot", () => withClient(async (c) => {
  const { u1, p1, t } = await seed(c);
  const id = await draft(c, p1, t);
  await submit(c, u1, id);
  const s = await sub(c, id);
  expect(s.status).toBe("submitted");
  expect(s.answers).toEqual(ANSWERS);
  expect(s.submitted_by).toBe(u1);
  expect(s.submitted_at).not.toBeNull();
  const co = (await c.query("select purpose, granted, template_version, form_submission_id from consents where patient_id=$1", [p1])).rows;
  expect(co).toEqual([{ purpose: "treatment", granted: true, template_version: 3, form_submission_id: id }]);
  expect((await auditActions(c, id)).map((r) => r.action)).toEqual(["form.submit"]);
  expect((await c.query("select 1 from audit_log where entity_id=$1 and action='consent.grant'", [p1])).rowCount).toBe(1);
  const snaps = await c.query("select answers, actor from form_submission_versions where submission_id=$1", [id]);
  expect(snaps.rows).toEqual([{ answers: ANSWERS, actor: u1 }]);
}));

it("submit_form: two consents in one go, each recorded separately", () => withClient(async (c) => {
  const { u1, p1, t } = await seed(c);
  const id = await draft(c, p1, t);
  await submit(c, u1, id, { ...ANSWERS, share_referrer: true }, ["treatment", "share_referrer"]);
  expect((await c.query("select purpose from consents where patient_id=$1 order by purpose", [p1])).rows.map((r) => r.purpose)).toEqual(["share_referrer", "treatment"]);
}));

it("submit_form: a patient cannot submit another patient's form; nobody anonymous; bookkeeper no", () => withClient(async (c) => {
  const { u1, u2, bk, p1, t } = await seed(c);
  const id = await draft(c, p1, t);
  for (const u of [u2, bk]) await expect(submit(c, u, id)).rejects.toThrow(/forbidden/);
  // no signed-in user at all (superuser connection, no JWT)
  await expect(c.query("select submit_form($1, $2::jsonb, $3::text[])", [id, JSON.stringify(ANSWERS), ["treatment"]])).rejects.toThrow(/forbidden/);
  // an id that does not exist looks the same as one that is not yours
  await expect(submit(c, u1, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/forbidden/);
  expect((await sub(c, id)).status).toBe("draft");
  expect((await c.query("select 1 from consents")).rowCount).toBe(0);
}));

it("submit_form: only draft or returned forms; a submitted form is rejected and left untouched; a returned one can be resubmitted", () => withClient(async (c) => {
  const { psy, u1, p1, t } = await seed(c);
  const id = await draft(c, p1, t);
  await submit(c, u1, id);
  await expect(submit(c, u1, id, { ...ANSWERS, name: "Changed" })).rejects.toThrow(/submission_not_open/);
  expect((await sub(c, id)).answers).toEqual(ANSWERS);
  await asUser(c, psy, () => c.query("update form_submissions set status='returned', return_note='Please add your surname' where id=$1", [id]));
  await submit(c, u1, id, { ...ANSWERS, name: "Ann Smith" });
  expect((await sub(c, id)).answers).toMatchObject({ name: "Ann Smith" });
  expect((await auditActions(c, id)).map((r) => r.action)).toEqual(["form.submit", "form.return", "form.submit"]);
  expect((await c.query("select 1 from form_submission_versions where submission_id=$1", [id])).rowCount).toBe(2);
}));

it("submit_form: consent purposes are checked against the template", () => withClient(async (c) => {
  const { u1, p1, t } = await seed(c);
  const id = await draft(c, p1, t);
  await expect(submit(c, u1, id, ANSWERS, ["treatment", "telehealth"])).rejects.toThrow(/consent_not_in_template/);
  await expect(submit(c, u1, id, ANSWERS, ["treatment", "treatment"])).rejects.toThrow(/duplicate_consent_purpose/);
  await expect(submit(c, u1, id, ANSWERS, [])).rejects.toThrow(/consent_required_missing/);
  await expect(submit(c, u1, id, ANSWERS, null)).rejects.toThrow(/consent_required_missing/);
  // a listed purpose needs its checkbox ticked, and a ticked optional checkbox needs its purpose listed
  await expect(submit(c, u1, id, { ...ANSWERS, consent_treatment: false }, ["treatment"])).rejects.toThrow(/consent_answer_mismatch/);
  await expect(submit(c, u1, id, { ...ANSWERS, share_referrer: true }, ["treatment"])).rejects.toThrow(/consent_answer_mismatch/);
  await expect(submit(c, u1, id, { name: "x" }, ["treatment"])).rejects.toThrow(/consent_answer_mismatch/);
  expect((await sub(c, id)).status).toBe("draft");
  expect((await c.query("select 1 from consents")).rowCount).toBe(0);
}));

it("submit_form: answers must be a JSON object under 100 kB", () => withClient(async (c) => {
  const { u1, p1, t } = await seed(c);
  const id = await draft(c, p1, t);
  for (const bad of [[1, 2], "text", 5, null]) await expect(submit(c, u1, id, bad), JSON.stringify(bad)).rejects.toThrow(/invalid_answers/);
  await expect(submit(c, u1, id, { ...ANSWERS, name: "x".repeat(102_500) })).rejects.toThrow(/answers_too_large/);
  expect((await sub(c, id)).status).toBe("draft");
}));

it("submit_form: a failing consent rolls everything back (status, answers, snapshot, audit, earlier consents)", () => withClient(async (c) => {
  // the template declares a purpose the consents table does not accept, so set_consent fails AFTER the status update and the first consent
  const { u1, p1, t } = await seed(c, { fields: [
    { key: "a", label: "A", type: "checkbox", required: true, consentPurpose: "treatment" },
    { key: "b", label: "B", type: "checkbox", required: true, consentPurpose: "marketing" }] });
  const id = await draft(c, p1, t);
  await expect(submit(c, u1, id, { a: true, b: true }, ["treatment", "marketing"])).rejects.toThrow(/invalid_purpose/);
  const s = await sub(c, id);
  expect(s.status).toBe("draft");
  expect(s.answers).toEqual({});
  expect(s.submitted_at).toBeNull();
  expect((await c.query("select 1 from consents")).rowCount).toBe(0);
  expect((await c.query("select 1 from form_submission_versions")).rowCount).toBe(0);
  expect(await auditActions(c, id)).toEqual([]);
}));

it("submit_form: guardian needs permissions.forms; staff submit on behalf and it is audited as theirs", () => withClient(async (c) => {
  const { psy, adm, p1, t } = await seed(c);
  const gNo = await guardian(c, p1, '{"book":true,"forms":false}'), gYes = await guardian(c, p1, '{"forms":true}');
  const id = await draft(c, p1, t);
  await expect(submit(c, gNo, id)).rejects.toThrow(/forbidden/);
  await submit(c, gYes, id);
  expect((await sub(c, id)).submitted_by).toBe(gYes);

  const id2 = await draft(c, p1, t);
  await submit(c, psy, id2);
  expect((await sub(c, id2)).submitted_by).toBe(psy);
  expect(await auditActions(c, id2)).toEqual([{ action: "form.submit", actor_id: psy }]);
  expect((await c.query("select detail->>'acted_by_role' as r from audit_log where entity_id=$1 and action='consent.grant' order by id desc limit 1", [p1])).rows[0].r).toBe("psychologist");

  const id3 = await draft(c, p1, t);
  await submit(c, adm, id3);
  expect((await sub(c, id3)).submitted_by).toBe(adm);
}));

// ---- return_note, answers cap, created_at ------------------------------------------------------------------------------
it("return_note: staff set it when returning (required, 1-1000 chars); patients can neither write nor clear it; it survives a resubmit", () => withClient(async (c) => {
  const { psy, u1, p1, t } = await seed(c);
  const id = await draft(c, p1, t);
  await submit(c, u1, id);
  const ret = (note: string | null) => asUser(c, psy, () => c.query("update form_submissions set status='returned', return_note=$2 where id=$1", [id, note]));
  await expect(ret(null)).rejects.toThrow(/return_note_required/);
  await expect(ret("   ")).rejects.toThrow(/fs_return_note_len|return_note_required/);
  await expect(ret("x".repeat(1001))).rejects.toThrow(/fs_return_note_len/);
  expect((await sub(c, id)).status).toBe("submitted");
  await ret("x".repeat(1000));
  await ret("Please add your surname").catch(() => undefined); // already returned: a second return is not a transition
  expect((await sub(c, id)).return_note).toBe("x".repeat(1000));

  // the patient sees it, cannot change it, and resubmitting keeps the latest note (history is in snapshots and the audit log)
  expect((await asUser(c, u1, () => c.query("select return_note from form_submissions where id=$1", [id]))).rows[0].return_note).toBe("x".repeat(1000));
  await expect(asUser(c, u1, () => c.query("update form_submissions set return_note='mine' where id=$1", [id]))).rejects.toThrow(/protected submission columns/);
  await expect(asUser(c, u1, () => c.query("update form_submissions set return_note=null where id=$1", [id]))).rejects.toThrow(/protected submission columns/);
  await submit(c, u1, id);
  expect((await sub(c, id)).return_note).toBe("x".repeat(1000));
  // and not on create
  await expect(asUser(c, u1, () => c.query("insert into form_submissions(patient_id,template_id,template_version,return_note) values ($1,$2,1,'n')", [p1, t]))).rejects.toThrow(/created as a draft/);
  // a draft's note cannot be set by staff either (only a return writes it)
  const d2 = await draft(c, p1, t);
  await expect(asUser(c, psy, () => c.query("update form_submissions set return_note='n' where id=$1", [d2]))).rejects.toThrow(/protected submission columns/);
}));

it("answers: capped at 100 kB on any write path and must be a JSON object; created_at is set and frozen", () => withClient(async (c) => {
  const { u1, p1, t } = await seed(c);
  const id = await draft(c, p1, t);
  const big = JSON.stringify({ a: "x".repeat(102_500) });
  await expect(asUser(c, u1, () => c.query("update form_submissions set answers=$2::jsonb where id=$1", [id, big]))).rejects.toThrow(/answers_too_large/);
  await asUser(c, u1, () => c.query(`update form_submissions set answers='{"a":"ok"}' where id=$1`, [id]));
  await expect(asUser(c, u1, () => c.query("update form_submissions set answers='[1]' where id=$1", [id]))).rejects.toThrow(/fs_answers_object/);
  expect((await sub(c, id)).created_at).not.toBeNull();
  await expect(asUser(c, u1, () => c.query("update form_submissions set created_at='2000-01-01' where id=$1", [id]))).rejects.toThrow(/protected submission columns/);
}));

// ---- restricted templates (health history) -------------------------------------------------------------------------------
it("restricted template: admin can neither read nor create nor submit its submissions; psychologist, patient and guardian can", () => withClient(async (c) => {
  const { psy, adm, bk, u1, p1 } = await seed(c);
  const open = (await c.query("insert into form_templates(key,version,schema) values ('reg',1,$1) returning id", [JSON.stringify(SCHEMA)])).rows[0].id as string;
  const rest = (await c.query("insert into form_templates(key,version,schema) values ('medical_history',1,$1) returning id", [JSON.stringify({ ...SCHEMA, restricted: true })])).rows[0].id as string;
  const gYes = await guardian(c, p1, '{"forms":true}');
  const sOpen = await draft(c, p1, open), sRest = await draft(c, p1, rest);
  await submit(c, u1, sRest); // the patient's own restricted form is submitted normally
  await submit(c, u1, sOpen);

  const ids = (u: string) => asUser(c, u, async () => (await c.query("select id from form_submissions order by created_at, id")).rows.map((r) => r.id as string));
  expect((await ids(adm)).sort()).toEqual([sOpen]);
  expect((await ids(psy)).sort()).toEqual([sOpen, sRest].sort());
  expect((await ids(u1)).sort()).toEqual([sOpen, sRest].sort());
  expect((await ids(gYes)).sort()).toEqual([sOpen, sRest].sort());
  expect((await ids(bk))).toEqual([]);

  // snapshots follow
  const snaps = (u: string) => asUser(c, u, async () => (await c.query("select submission_id from form_submission_versions")).rows.map((r) => r.submission_id as string));
  expect(await snaps(adm)).toEqual([sOpen]);
  expect((await snaps(psy)).sort()).toEqual([sOpen, sRest].sort());

  // the admin cannot create one, return one, or submit one on someone's behalf (nor learn it exists)
  await expect(asUser(c, adm, () => c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1)", [p1, rest]))).rejects.toThrow(/row-level security/);
  expect((await asUser(c, adm, () => c.query("update form_submissions set status='returned', return_note='n' where id=$1", [sRest]))).rowCount).toBe(0);
  expect((await sub(c, sRest)).status).toBe("submitted");
  const d = await draft(c, p1, rest);
  await expect(submit(c, adm, d)).rejects.toThrow(/forbidden/);
  // the psychologist may do all of it
  await asUser(c, psy, () => c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1)", [p1, rest]));
  await submit(c, psy, d);
  expect((await sub(c, d)).status).toBe("submitted");
  // ... and the admin still manages the open template
  await asUser(c, adm, () => c.query("update form_submissions set status='returned', return_note='n' where id=$1", [sOpen]));
}));

it("restricted flag: only 'true' restricts; templates without it, or with other values, stay open to the admin", () => withClient(async (c) => {
  const { adm, p1 } = await seed(c, { fields: [] });
  for (const [i, restricted] of [[1, false], [2, "yes"], [3, null]] as const) {
    const t = (await c.query("insert into form_templates(key,version,schema) values ('k',$1,$2) returning id", [i, JSON.stringify({ restricted })])).rows[0].id;
    await draft(c, p1, t);
  }
  expect((await asUser(c, adm, () => c.query("select 1 from form_submissions"))).rowCount).toBe(3);
}));

it("helper functions are not callable anonymously", () => withClient(async (c) => {
  await c.query("set local role anon");
  await expect(c.query("select submit_form(gen_random_uuid(), '{}'::jsonb, '{}'::text[])")).rejects.toThrow(/permission denied/);
  await expect(c.query("select template_restricted(gen_random_uuid())")).rejects.toThrow(/permission denied/);
  await expect(c.query("select staff_form_access(gen_random_uuid())")).rejects.toThrow(/permission denied/);
  await c.query("reset role");
}));
