import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

// R34: the exact statements app/app/notes/actions.ts and lib/notes/risk-task.ts send (through PostgREST) replayed as SQL against the current
// rules, so a later migration that changes a rule breaks here rather than in production. No migration was added for Task 12.
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
      .toEqual([{ version_no: 1, s: null, saved_by: m.psy }, { version_no: 2, s: "one", saved_by: m.psy }]); // each version holds the text BEFORE that save
    await c.query("select sign_note($1)", [id]);
    expect((await save("three")).rowCount).toBe(0); // closed: no error, no row
    expect((await c.query("select content->>'subjective' as s from clinical_notes where id=$1", [id])).rows[0].s).toBe("two");
  });
}));

it("risk task: the psychologist's tasks insert (source risk_flag:<note>:<level>) works and the lookup finds it", () => withClient(async (c) => {
  const m = await mk(c);
  await asUser(c, m.psy, async () => {
    const id = (await create(c, m, m.psy)).rows[0].id;
    const source = `risk_flag:${id}:high`;
    expect((await c.query("select id from tasks where source=$1 limit 1", [source])).rowCount).toBe(0);
    await c.query("insert into tasks(title,priority,patient_id,appointment_id,source) values ($1,'high',$2,$3,$4)", ["Risk flagged: professional assessment and follow-up required", m.p, m.ap, source]);
    expect((await c.query("select priority, status, patient_id from tasks where source=$1", [source])).rows).toEqual([{ priority: "high", status: "open", patient_id: m.p }]);
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

it("the linking rule is app-side: the database itself would accept another patient's appointment, so createNote must check it", () => withClient(async (c) => {
  const m = await mk(c);
  // documents why app/app/notes/actions.ts validates appointment ownership and status before the insert (no FK/trigger enforces patient match)
  await expect(asUser(c, m.psy, () => create(c, { p: m.other, tpl: m.tpl, ap: m.ap }, m.psy))).resolves.toBeDefined();
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
