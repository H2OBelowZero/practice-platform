import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

// R34: the exact statements app/app/notes/actions.ts and lib/notes/risk-task.ts (raise_risk_task) send (through PostgREST) replayed as SQL against the current
// rules, so a later migration that changes a rule breaks here rather than in production. Migration 0013 (Task 12 fix round) hardened notes and risk tasks.
async function mk(c: Client) {
  const psy = await mkUser(c, "psychologist"), psy2 = await mkUser(c, "psychologist", "psy2"), adm = await mkUser(c, "admin");
  const p = (await c.query("insert into patients(first_name,last_name) values ('P','Q') returning id")).rows[0].id;
  const other = (await c.query("insert into patients(first_name,last_name) values ('O','T') returning id")).rows[0].id;
  const tpl = (await c.query("select id from note_templates where name='SOAP'")).rows[0].id;
  const st = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('T',50,100) returning id")).rows[0].id;
  const ap = (await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,'2030-01-07T08:00:00Z','2030-01-07T08:50:00Z','attended') returning id", [p, st])).rows[0].id;
  return { psy, psy2, adm, p, other, tpl, ap };
}
const create = (c: Client, m: { p: string; tpl: string; ap: string | null }, author: string) =>
  c.query("insert into clinical_notes(patient_id,appointment_id,template_id,author_id,state) values ($1,$2,$3,$4,'draft') returning id", [m.p, m.ap, m.tpl, author]);

it("createNote: the psychologist inserts a draft as themself; an admin and a forged author are refused", () => withClient(async (c) => {
  const m = await mk(c);
  const id = await asUser(c, m.psy, async () => (await create(c, m, m.psy)).rows[0].id);
  expect((await c.query("select state, content, risk, author_id from clinical_notes where id=$1", [id])).rows[0]).toEqual({ state: "draft", content: {}, risk: {}, author_id: m.psy });
  await expect(asUser(c, m.psy, () => create(c, m, m.psy2))).rejects.toThrow(/row-level security/);
  await expect(asUser(c, m.adm, () => create(c, m, m.adm))).rejects.toThrow(/row-level security/);
}));

it("saveNoteDraft: update .eq(state, draft) changes a draft (and versions the old text) and matches zero rows once signed", () => withClient(async (c) => {
  const m = await mk(c);
  await asUser(c, m.psy, async () => {
    const id = (await create(c, m, m.psy)).rows[0].id;
    const save = (text: string) => c.query("update clinical_notes set content=$2, risk=$3 where id=$1 and state='draft' returning id", [id, JSON.stringify({ subjective: text, objective: "", assessment: "", plan: "" }), JSON.stringify({ level: "none", notes: "" })]);
    expect((await save("one")).rowCount).toBe(1);
    expect((await save("two")).rowCount).toBe(1);
    expect((await c.query("select version_no, content->>'subjective' as s, saved_by from note_versions where note_id=$1 order by version_no", [id])).rows)
      .toEqual([{ version_no: 1, s: null, saved_by: m.psy }]); // the version holds the text BEFORE the save; the second save, 0 minutes later by the same author, is throttled (0013)
    await c.query("select sign_note($1)", [id]);
    expect((await c.query("select content->>'subjective' as s from note_versions where note_id=$1 order by version_no desc limit 1", [id])).rows[0].s).toBe("two"); // signing kept the last draft text, which the throttle had not versioned (0013)
    expect((await save("three")).rowCount).toBe(0); // closed: no error, no row
    expect((await c.query("select content->>'subjective' as s from clinical_notes where id=$1", [id])).rows[0].s).toBe("two");
  });
}));

it("risk task: raise_risk_task(p_note, p_level, p_title) as the psychologist creates one assigned task; the lookup of it works (0013)", () => withClient(async (c) => {
  const m = await mk(c);
  await asUser(c, m.psy, async () => {
    const id = (await create(c, m, m.psy)).rows[0].id;
    const title = "Risk flagged: professional assessment and follow-up required";
    await c.query("select raise_risk_task($1,'moderate',$2)", [id, title]);
    expect((await c.query("select title, priority, status, patient_id, appointment_id, assignee, meta, source from tasks where source=$1", [`risk_flag:${id}`])).rows)
      .toEqual([{ title, priority: "high", status: "open", patient_id: m.p, appointment_id: m.ap, assignee: m.psy, meta: { level: "moderate" }, source: `risk_flag:${id}` }]);
  });
  await expect(asUser(c, m.adm, () => c.query("select id from clinical_notes"))).resolves.toMatchObject({ rowCount: 0 });
}));

it("signNote / addAddendum: sign_note is author-only and audited, add_addendum needs a signed note and marks it amended", () => withClient(async (c) => {
  const m = await mk(c);
  const id = await asUser(c, m.psy, async () => (await create(c, m, m.psy)).rows[0].id);
  await expect(asUser(c, m.psy2, () => c.query("select sign_note($1)", [id]))).rejects.toThrow(/not_author/);
  await expect(asUser(c, m.psy, () => c.query("select add_addendum($1,'x')", [id]))).rejects.toThrow(/note_not_signed/); // a draft takes no addendum
  await asUser(c, m.psy, async () => { await c.query("select sign_note($1)", [id]); });
  await expect(asUser(c, m.psy, () => c.query("select sign_note($1)", [id]))).rejects.toThrow(/note not draftable/); // already signed
  await expect(asUser(c, m.psy, () => c.query("select add_addendum($1,'   ')", [id]))).rejects.toThrow(); // blank is refused by the table check
  await asUser(c, m.psy2, async () => { await c.query("select add_addendum($1,'late correction')", [id]); }); // any psychologist may add one, as themself
  const r = await c.query("select state from clinical_notes where id=$1", [id]);
  expect(r.rows[0].state).toBe("amended");
  expect((await c.query("select author_id from note_addenda where note_id=$1", [id])).rows[0].author_id).toBe(m.psy2);
  expect((await c.query("select action, detail from audit_log where entity_id=$1 order by id", [id])).rows.map((x) => x.action)).toEqual(["note.sign", "note.addendum"]);
}));

it("createNote's app check is backed by the database: another patient's appointment and a second note for one appointment are refused (0013)", () => withClient(async (c) => {
  const m = await mk(c);
  await expect(asUser(c, m.psy, () => create(c, { p: m.other, tpl: m.tpl, ap: m.ap }, m.psy))).rejects.toThrow(/appointment_patient_mismatch/);
  await asUser(c, m.psy, () => create(c, m, m.psy)); // first note for this patient's appointment
  await expect(asUser(c, m.psy, () => create(c, m, m.psy))).rejects.toThrow(/duplicate key/); // the app maps this to "a note already exists"
}));

it("version listing and the person lookup the note page makes are readable by the psychologist only", () => withClient(async (c) => {
  const m = await mk(c);
  const id = await asUser(c, m.psy, async () => {
    const n = (await create(c, m, m.psy)).rows[0].id;
    await c.query("update clinical_notes set content='{\"plan\":\"a\"}' where id=$1", [n]);
    return n;
  });
  expect(await asUser(c, m.psy, async () => (await c.query("select id, version_no, saved_by, saved_at from note_versions where note_id=$1 order by version_no desc limit 100", [id])).rowCount)).toBe(1);
  expect(await asUser(c, m.adm, async () => (await c.query("select id from note_versions where note_id=$1", [id])).rowCount)).toBe(0);
  expect(await asUser(c, m.psy, async () => (await c.query("select user_id, display_name from profiles where user_id = any($1)", [[m.psy, m.psy2]])).rowCount)).toBe(2);
}));
