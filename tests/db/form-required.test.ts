import { it, expect } from "vitest";
import type { Client } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { asUser, mkUser, withClient } from "./helpers";

// 0033 (final review M5): submit_form enforces the template's required fields and answer shapes in the database.
// I5: the clinical questions moved into the restricted presenting_concerns template, which the admin cannot read.

const seedSql = readFileSync(join(__dirname, "..", "..", "supabase", "seed.sql"), "utf8");

async function world(c: Client) {
  await c.query(seedSql);
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), u = await mkUser(c, "patient");
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u])).rows[0].id as string;
  /** the newest version of a template key */
  const tplId = async (key: string) => (await c.query("select id from form_templates where key=$1 order by version desc limit 1", [key])).rows[0].id as string;
  /** a draft the patient opens themself (as the portal does) */
  const draft = async (key: string) => {
    const t = await tplId(key);
    return asUser(c, u, async () => (await c.query("insert into form_submissions(patient_id,template_id) values ($1,$2) returning id", [p, t])).rows[0].id as string, { aal: "aal1" });
  };
  /** the RPC exactly as PostgREST would call it with the caller's own token */
  const submit = (who: string, id: string, answers: unknown, purposes: string[]) =>
    asUser(c, who, () => c.query("select submit_form($1,$2::jsonb,$3)", [id, JSON.stringify(answers), purposes]));
  return { psy, adm, u, p, draft, submit, tplId };
}
const status = async (c: Client, id: string) => (await c.query("select status from form_submissions where id=$1", [id])).rows[0].status as string;

it("informed consent with an empty typed signature is refused by a direct RPC call; a complete one is accepted", () => withClient(async (c) => {
  const w = await world(c);
  const id = await w.draft("informed_consent");
  for (const typed of [undefined, "", "   ", null]) {
    const answers: Record<string, unknown> = { understood: true, consent_treatment: true };
    if (typed !== undefined) answers.typed_name = typed;
    await expect(w.submit(w.u, id, answers, ["treatment"]), String(typed)).rejects.toThrow(/required_field_missing: typed_name/);
  }
  await expect(w.submit(w.u, id, { understood: false, consent_treatment: true, typed_name: "A A" }, ["treatment"])).rejects.toThrow(/required_field_missing: understood/);
  await expect(w.submit(w.u, id, { understood: "true", consent_treatment: true, typed_name: "A A" }, ["treatment"])).rejects.toThrow(/invalid_field_value: understood/);
  await expect(w.submit(w.u, id, { understood: true, consent_treatment: true, typed_name: 42 }, ["treatment"])).rejects.toThrow(/invalid_field_value: typed_name/);
  expect(await status(c, id)).toBe("draft"); // nothing happened, no consent recorded
  expect((await c.query("select count(*)::int n from consents where patient_id=$1", [w.p])).rows[0].n).toBe(0);
  // the consent checks keep their own error and run first
  await expect(w.submit(w.u, id, { understood: true, consent_treatment: false, typed_name: "A A" }, [])).rejects.toThrow(/consent_required_missing/);
  await w.submit(w.u, id, { understood: true, consent_treatment: true, typed_name: "A A" }, ["treatment"]);
  expect(await status(c, id)).toBe("submitted");
}));

it("selects must be one of their options; required selects must be answered; staff submitting on behalf are held to the same rules", () => withClient(async (c) => {
  const w = await world(c);
  const id = await w.draft("registration"); // version 2
  const ok = { contact_preference: "Email", safe_to_leave_message: "Yes", previous_therapy: "No", emergency_name: "B", emergency_phone: "000", emergency_relationship: "Sister" };
  await expect(w.submit(w.u, id, { ...ok, contact_preference: "Carrier pigeon" }, [])).rejects.toThrow(/invalid_field_value: contact_preference/);
  await expect(w.submit(w.u, id, { ...ok, contact_preference: "" }, [])).rejects.toThrow(/required_field_missing: contact_preference/);
  await expect(w.submit(w.psy, id, { ...ok, emergency_phone: " " }, [])).rejects.toThrow(/required_field_missing: emergency_phone/);
  await expect(w.submit(w.psy, id, { ...ok, previous_therapy: ["No"] }, [])).rejects.toThrow(/invalid_field_value: previous_therapy/);
  await w.submit(w.u, id, { ...ok, how_heard: "" }, []); // an optional field may be blank
  expect(await status(c, id)).toBe("submitted");
}));

it("dates must be real YYYY-MM-DD dates", () => withClient(async (c) => {
  const w = await world(c);
  await c.query(`insert into form_templates(key,version,schema) values ('dated',1,'{"fields":[{"key":"d","label":"D","type":"date","required":true},{"key":"e","label":"E","type":"date"}]}')`);
  for (const [answers, err] of [[{ d: "2030-02-30" }, /invalid_field_value: d/], [{ d: "30/01/2030" }, /invalid_field_value: d/], [{ d: "2030-01-01", e: "soon" }, /invalid_field_value: e/], [{}, /required_field_missing: d/]] as const) {
    const id = await w.draft("dated");
    await expect(w.submit(w.u, id, answers, []), JSON.stringify(answers)).rejects.toThrow(err);
  }
  const id = await w.draft("dated");
  await w.submit(w.u, id, { d: "2030-01-31" }, []);
  expect(await status(c, id)).toBe("submitted");
}));

it("I5: presenting concerns are psychologist-only; the admin reads the version 2 registration, which no longer asks why the person comes", () => withClient(async (c) => {
  const w = await world(c);
  const pc = await w.draft("presenting_concerns");
  await w.submit(w.u, pc, { reason_for_visit: "Fictional: trouble sleeping", court_orders: "none" }, []);
  const reg = await w.draft("registration");
  await w.submit(w.u, reg, { contact_preference: "Email", safe_to_leave_message: "Yes", previous_therapy: "No", emergency_name: "B", emergency_phone: "000", emergency_relationship: "Sister" }, []);
  const read = (who: string, id: string) => asUser(c, who, async () => (await c.query("select answers from form_submissions where id=$1", [id])).rows);
  const versions = (who: string, id: string) => asUser(c, who, async () => (await c.query("select 1 from form_submission_versions where submission_id=$1", [id])).rowCount);
  expect(await read(w.adm, pc)).toEqual([]);
  expect(await versions(w.adm, pc)).toBe(0);
  expect((await read(w.psy, pc))[0].answers.reason_for_visit).toMatch(/trouble sleeping/);
  expect((await asUser(c, w.u, async () => (await c.query("select answers from form_submissions where id=$1", [pc])).rows, { aal: "aal1" }))[0].answers.court_orders).toBe("none");
  const regRows = await read(w.adm, reg);
  expect(regRows).toHaveLength(1);
  expect(Object.keys(regRows[0].answers)).not.toContain("reason_for_visit");
  // the admin can neither request (insert) nor submit a presenting-concerns form
  await expect(asUser(c, w.adm, async () => c.query("insert into form_submissions(patient_id,template_id) values ($1,$2)", [w.p, await w.tplId("presenting_concerns")]))).rejects.toThrow(/row-level security/);
  const pc2 = await w.draft("presenting_concerns");
  await expect(w.submit(w.adm, pc2, { reason_for_visit: "x" }, [])).rejects.toThrow(/forbidden/);
  // a later version of the key stays restricted even if someone forgets the flag (0012 inheritance)
  await c.query(`insert into form_templates(key,version,schema) values ('presenting_concerns',2,'{"fields":[{"key":"reason_for_visit","label":"R","type":"textarea"}]}')`);
  expect((await c.query("select schema->>'restricted' r from form_templates where key='presenting_concerns' and version=2")).rows[0].r).toBe("true");
}));
