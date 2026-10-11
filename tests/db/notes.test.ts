import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, asService, mkUser } from "./helpers";

/** psychologist + every other role, one patient with a draft note (template + appointment attached) */
async function mk(c: Client) {
  const psy = await mkUser(c, "psychologist"); const adm = await mkUser(c, "admin");
  const bk = await mkUser(c, "bookkeeper"); const pu = await mkUser(c, "patient");
  const gu = await mkUser(c, "guardian"); const assoc = await mkUser(c, "associate");
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'P','Q') returning id", [pu])).rows[0].id;
  await c.query("insert into guardianships(guardian_user_id,patient_id) values ($1,$2)", [gu, p]);
  const tpl = (await c.query("select id from note_templates where name='SOAP'")).rows[0].id;
  const st = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('T',50,100) returning id")).rows[0].id;
  const ap = (await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,'2030-01-07T08:00:00Z','2030-01-07T08:50:00Z') returning id", [p, st])).rows[0].id;
  const n = (await c.query("insert into clinical_notes(patient_id,author_id,template_id,appointment_id,content) values ($1,$2,$3,$4,'{\"s\":\"x\"}') returning id", [p, psy, tpl, ap])).rows[0].id;
  return { psy, adm, bk, pu, gu, assoc, p, tpl, ap, n };
}
const sign = (c: Client, n: string) => c.query("select sign_note($1)", [n]);
const state = async (c: Client, n: string) => (await c.query("select state from clinical_notes where id=$1", [n])).rows[0].state;
async function asAnon<T>(c: Client, fn: () => Promise<T>) {
  await c.query("set local role anon");
  try { return await fn(); } finally { await c.query("reset role"); }
}

it("only the psychologist can read notes, versions and addenda; templates are staff-only", () => withClient(async (c) => {
  const { psy, adm, bk, pu, gu, assoc, n } = await mk(c);
  await c.query("update clinical_notes set content='{\"s\":\"y\"}' where id=$1", [n]); // makes a version
  await asUser(c, psy, async () => { await sign(c, n); await c.query("select add_addendum($1,'late')", [n]); });
  const cases: [string, string, number, number][] = [ // role, user, rows in notes/versions/addenda, rows in templates
    ["psychologist", psy, 1, 3], ["admin", adm, 0, 3], ["bookkeeper", bk, 0, 3], ["associate", assoc, 0, 3],
    ["patient", pu, 0, 0], ["guardian", gu, 0, 0]];
  for (const [role, u, expected, tpls] of cases) {
    for (const t of ["clinical_notes", "note_versions", "note_addenda"])
      expect(await asUser(c, u, async () => (await c.query(`select 1 from ${t}`)).rowCount), `${role} ${t}`).toBe(expected);
    expect(await asUser(c, u, async () => (await c.query("select 1 from note_templates")).rowCount), `${role} templates`).toBe(tpls);
  }
  for (const t of ["clinical_notes", "note_versions", "note_addenda", "note_templates"])
    await expect(asAnon(c, () => c.query(`select 1 from ${t}`))).rejects.toThrow(/permission denied/);
}));

it("signed notes cannot be edited or deleted; addenda allowed", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  await asUser(c, psy, async () => {
    await c.query("select sign_note($1)", [n]);
    await expect(c.query("update clinical_notes set content='{\"s\":\"changed\"}' where id=$1", [n])).rejects.toThrow(/immutable/);
    await expect(c.query("delete from clinical_notes where id=$1", [n])).rejects.toThrow(/immutable/);
    await c.query("select add_addendum($1,'late correction')", [n]);
    expect(await state(c, n)).toBe("amended");
    await c.query("select add_addendum($1,'second correction')", [n]); // amended stays amended
    expect(await state(c, n)).toBe("amended");
    expect((await c.query("select author_id from note_addenda where note_id=$1", [n])).rows.map((r) => r.author_id)).toEqual([psy, psy]);
  });
}));

it("notes are never deleted, not even drafts (versions are append-only)", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  await asUser(c, psy, async () => {
    await expect(c.query("delete from clinical_notes where id=$1", [n])).rejects.toThrow(/immutable/);
  });
  await expect(c.query("delete from clinical_notes where id=$1", [n])).rejects.toThrow(/immutable/); // owner too
}));

it("non-draft notes reject changes to content, risk, template, appointment, patient, author and signed_at", () => withClient(async (c) => {
  const { psy, n, tpl } = await mk(c);
  const other = (await c.query("insert into patients(first_name,last_name) values ('O','O') returning id")).rows[0].id;
  const other_user = await mkUser(c, "psychologist");
  const bad = ["content='{}'", "risk='{\"r\":1}'", "template_id=null", "appointment_id=null", `patient_id='${other}'`,
    `author_id='${other_user}'`, "signed_at=null", "signed_at=now()+interval '1 day'","created_at=now()+interval '1 day'"];
  const check = async (st: string) => {
    expect(await state(c, n)).toBe(st);
    for (const set of bad) {
      const q = `update clinical_notes set ${set} where id=$1`;
      await expect(asUser(c, psy, () => c.query(q, [n])), `psy/${st}: ${set}`).rejects.toThrow(/immutable/);
      await expect(c.query(q, [n]), `owner/${st}: ${set}`).rejects.toThrow(/immutable/);
    }
  };
  await asUser(c, psy, () => sign(c, n)); await check("signed");
  await asUser(c, psy, () => c.query("select add_addendum($1,'a')", [n])); await check("amended");
  expect((await c.query("select template_id from clinical_notes where id=$1", [n])).rows[0].template_id).toBe(tpl);
}));

it("state machine: draft->signed by the author, signed->amended only with an addendum, nothing else", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  await asUser(c, psy, async () => {
    await expect(c.query("update clinical_notes set state='amended' where id=$1", [n])).rejects.toThrow(/invalid_state_transition/);
    await expect(c.query("update clinical_notes set signed_at=now() where id=$1", [n])).rejects.toThrow(/signed_at/);
    await sign(c, n);
    for (const s of ["draft", "amended"]) // regress, or amend without an addendum
      await expect(c.query(`update clinical_notes set state='${s}' where id=$1`, [n]), s).rejects.toThrow(/invalid_state_transition/);
    await c.query("update clinical_notes set state='signed' where id=$1", [n]); // no-op update is harmless
    await c.query("select add_addendum($1,'a')", [n]);
    for (const s of ["draft", "signed"])
      await expect(c.query(`update clinical_notes set state='${s}' where id=$1`, [n]), s).rejects.toThrow(/invalid_state_transition/);
    expect(await state(c, n)).toBe("amended");
  });
  // the owner is bound by the same machine
  await expect(c.query("update clinical_notes set state='draft' where id=$1", [n])).rejects.toThrow(/invalid_state_transition/);
}));

it("direct writes get the same protection: the author's UPDATE signs once with one audit row", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  await asUser(c, psy, () => c.query("update clinical_notes set state='signed' where id=$1", [n]));
  const r = (await c.query("select state, signed_at = now() as at_now from clinical_notes where id=$1", [n])).rows[0];
  expect(r).toEqual({ state: "signed", at_now: true });
  const audit = (await c.query("select action, actor_id from audit_log where entity_id=$1", [n])).rows;
  expect(audit).toEqual([{ action: "note.sign", actor_id: psy }]);
}));

it("direct INSERT into note_addenda amends the note and writes one audit row", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  await asUser(c, psy, async () => {
    await sign(c, n);
    await c.query("insert into note_addenda(note_id,content,author_id) values ($1,'direct',$2)", [n, psy]);
    expect(await state(c, n)).toBe("amended");
  });
  const audit = (await c.query("select action, actor_id from audit_log where entity_id=$1 order by id", [n])).rows;
  expect(audit).toEqual([{ action: "note.sign", actor_id: psy }, { action: "note.addendum", actor_id: psy }]);
}));

it("a signed note cannot be flipped to amended without an addendum, and a forged app.note_op flag does nothing", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  const psy2 = await mkUser(c, "psychologist");
  const flag = (v: string) => c.query("select set_config('app.note_op', $1, true)", [v]);
  await asUser(c, psy2, async () => {
    await flag("sign");
    await expect(c.query("update clinical_notes set state='signed' where id=$1", [n])).rejects.toThrow(/not_author/);
    await expect(sign(c, n)).rejects.toThrow(/not_author/);
  });
  expect(await state(c, n)).toBe("draft");
  await asUser(c, psy, async () => {
    await sign(c, n);
    await flag("addendum");
    await expect(c.query("update clinical_notes set state='amended' where id=$1", [n])).rejects.toThrow(/invalid_state_transition/);
  });
  expect(await state(c, n)).toBe("signed");
}));

it("only the author can sign; addenda are attributed to the caller and need a signed note", () => withClient(async (c) => {
  const { psy, adm, bk, pu, assoc, n } = await mk(c);
  const psy2 = await mkUser(c, "psychologist");
  for (const u of [psy2, adm, bk, pu, assoc])
    await expect(asUser(c, u, () => sign(c, n))).rejects.toThrow(/not_author/);
  await expect(asService(c, () => sign(c, n))).rejects.toThrow(/not_author/);
  await expect(asService(c, () => c.query("update clinical_notes set state='signed' where id=$1", [n]))).rejects.toThrow(/not_author/);
  await expect(c.query("update clinical_notes set state='signed' where id=$1", [n])).rejects.toThrow(/not_author/); // owner has no uid either
  expect(await state(c, n)).toBe("draft");
  await expect(asUser(c, psy, () => c.query("select add_addendum($1,'too early')", [n]))).rejects.toThrow(/note_not_signed/);
  await expect(asUser(c, psy, () => c.query("insert into note_addenda(note_id,content,author_id) values ($1,'x',$2)", [n, psy]))).rejects.toThrow(/note_not_signed/);
  await asUser(c, psy, async () => { await sign(c, n); });
  await expect(asUser(c, psy, () => sign(c, n))).rejects.toThrow(/note not draftable/); // already signed
  await asUser(c, psy2, () => c.query("select add_addendum($1,'second opinion')", [n]));
  expect((await c.query("select author_id from note_addenda where note_id=$1", [n])).rows[0].author_id).toBe(psy2);
  await expect(asUser(c, psy2, () => c.query("insert into note_addenda(note_id,content,author_id) values ($1,'x',$2)", [n, psy]))).rejects.toThrow(/not_author/); // spoofed author
  await expect(asUser(c, psy, () => c.query("select add_addendum($1,' ')", [n]))).rejects.toThrow(/note_addenda_content_check/);
  await expect(asUser(c, psy, () => c.query("select add_addendum(gen_random_uuid(),'x')"))).rejects.toThrow(/note_not_signed/);
}));

it("inserted notes must be drafts authored by the caller", () => withClient(async (c) => {
  const { psy, p } = await mk(c);
  const psy2 = await mkUser(c, "psychologist");
  const ins = (author: string, extra = "state", val = "'draft'") =>
    c.query(`insert into clinical_notes(patient_id,author_id,${extra}) values ($1,$2,${val})`, [p, author]);
  await asUser(c, psy, async () => {
    await ins(psy); // ok
    await expect(ins(psy, "state", "'signed'")).rejects.toThrow(/draft/);
    await expect(ins(psy, "state", "'amended'")).rejects.toThrow(/draft/);
    await expect(ins(psy, "signed_at", "now()")).rejects.toThrow(/draft/);
    await expect(ins(psy2)).rejects.toThrow(/row-level security/);
  });
  await expect(ins(psy, "state", "'signed'")).rejects.toThrow(/draft/); // owner too
}));

it("drafts: author and patient are fixed, every content change keeps the previous content as a version", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  const other = (await c.query("insert into patients(first_name,last_name) values ('O','O') returning id")).rows[0].id;
  const psy2 = await mkUser(c, "psychologist");
  await asUser(c, psy, async () => {
    await expect(c.query("update clinical_notes set patient_id=$2 where id=$1", [n, other])).rejects.toThrow(/immutable/);
    await expect(c.query("update clinical_notes set author_id=$2 where id=$1", [n, psy2])).rejects.toThrow(/immutable/);
    await c.query("update clinical_notes set content='{\"s\":\"x\"}' where id=$1", [n]); // unchanged: no version
    await c.query("update clinical_notes set risk='{\"r\":1}' where id=$1", [n]);
    for (const v of ["e1", "e2", "e3"]) await c.query("update clinical_notes set content=$2::jsonb where id=$1", [n, JSON.stringify({ s: v })]);
    const { rows } = await c.query("select version_no, content, saved_by from note_versions where note_id=$1 order by version_no", [n]);
    expect(rows.map((r) => r.version_no)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.content)).toEqual([{ s: "x" }, { s: "e1" }, { s: "e2" }]);
    expect(rows.every((r) => r.saved_by === psy)).toBe(true);
    expect((await c.query("select content from clinical_notes where id=$1", [n])).rows[0].content).toEqual({ s: "e3" });
  });
}));

it("note_versions and note_addenda are append-only for everyone", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  await asUser(c, psy, async () => {
    await c.query("update clinical_notes set content='{\"s\":\"e1\"}' where id=$1", [n]);
    await sign(c, n); await c.query("select add_addendum($1,'a')", [n]);
    for (const q of ["update note_versions set content='{}'", "delete from note_versions", "insert into note_versions(note_id,version_no,content) select id,99,'{}' from clinical_notes",
      "update note_addenda set content='z'", "delete from note_addenda"])
      await expect(c.query(q), q).rejects.toThrow(/permission denied/);
  });
  // privilege revokes on note_versions/note_addenda rely on the harness default grants (Supabase grants API roles all on new tables)
  await asService(c, async () => {
    for (const q of ["update note_versions set content='{}'", "delete from note_versions", "insert into note_versions(note_id,version_no,content) select id,99,'{}' from clinical_notes",
      "update note_addenda set content='z'", "delete from note_addenda"])
      await expect(c.query(q), q).rejects.toThrow(/permission denied/);
  });
  for (const q of ["update note_versions set content='{}'", "delete from note_versions", "update note_addenda set content='z'", "delete from note_addenda"])
    await expect(c.query(q), q).rejects.toThrow(/append-only/); // even the owner
  expect((await c.query("select count(*)::int n from note_versions")).rows[0].n).toBe(1);
}));

it("non-psychologists cannot insert, update or delete notes or addenda", () => withClient(async (c) => {
  const { psy, adm, bk, pu, gu, assoc, p, n } = await mk(c);
  await asUser(c, psy, async () => { await sign(c, n); await c.query("select add_addendum($1,'a')", [n]); });
  const d = (await c.query("insert into clinical_notes(patient_id,author_id) values ($1,$2) returning id", [p, psy])).rows[0].id; // a draft
  for (const [role, u] of [["admin", adm], ["bookkeeper", bk], ["patient", pu], ["guardian", gu], ["associate", assoc]] as const) {
    await asUser(c, u, async () => {
      await expect(c.query("insert into clinical_notes(patient_id,author_id) values ($1,$2)", [p, u]), role).rejects.toThrow(/row-level security/);
      await expect(c.query("insert into clinical_notes(patient_id,author_id) values ($1,$2)", [p, psy]), role).rejects.toThrow(/row-level security/);
      await expect(c.query("insert into note_addenda(note_id,content,author_id) values ($1,'x',$2)", [n, u]), role).rejects.toThrow(/row-level security|permission denied/);
      await expect(c.query("select add_addendum($1,'x')", [n]), role).rejects.toThrow(/row-level security|permission denied/);
      await expect(c.query("select sign_note($1)", [d]), role).rejects.toThrow(/not_author/);
      expect((await c.query("update clinical_notes set content='{\"s\":\"hack\"}' where id=$1", [d])).rowCount, role).toBe(0);
      expect((await c.query("delete from clinical_notes where id=$1", [d])).rowCount, role).toBe(0);
    });
  }
  expect((await c.query("select content from clinical_notes where id=$1", [d])).rows[0].content).toEqual({});
  expect((await c.query("select count(*)::int n from note_addenda")).rows[0].n).toBe(1);
}));

it("sign_note and add_addendum write audit rows attributed to the caller", () => withClient(async (c) => {
  const { psy, n } = await mk(c);
  await asUser(c, psy, async () => { await sign(c, n); await c.query("select add_addendum($1,'a')", [n]); });
  const { rows } = await c.query("select action, entity, entity_id, actor_id, role from audit_log where entity_id=$1 order by id", [n]);
  expect(rows).toEqual([
    { action: "note.sign", entity: "clinical_notes", entity_id: n, actor_id: psy, role: "psychologist" },
    { action: "note.addendum", entity: "clinical_notes", entity_id: n, actor_id: psy, role: "psychologist" }]);
  // a rejected attempt leaves no audit row
  const before = (await c.query("select count(*)::int n from audit_log")).rows[0].n;
  await expect(asUser(c, psy, () => sign(c, n))).rejects.toThrow(/note not draftable/);
  expect((await c.query("select count(*)::int n from audit_log")).rows[0].n).toBe(before);
}));

it("anon cannot execute the note functions", () => withClient(async (c) => {
  const { n } = await mk(c);
  await expect(asAnon(c, () => sign(c, n))).rejects.toThrow(/permission denied/);
  await expect(asAnon(c, () => c.query("select add_addendum($1,'x')", [n]))).rejects.toThrow(/permission denied/);
  const { rows } = await c.query(
    "select p.proname, has_function_privilege('anon', p.oid,'execute') a, has_function_privilege('authenticated', p.oid,'execute') u, has_function_privilege('service_role', p.oid,'execute') s from pg_proc p where proname in ('sign_note','add_addendum','notes_guard','addenda_guard','addenda_after')");
  expect(rows.map((r) => [r.proname, r.a, r.u, r.s]).sort()).toEqual(["add_addendum", "addenda_after", "addenda_guard", "notes_guard", "sign_note"].map((f) => [f, false, true, true]));
}));

it("templates are read-only for the psychologist (no write policy)", () => withClient(async (c) => {
  const { psy } = await mk(c);
  await asUser(c, psy, async () => {
    await expect(c.query("insert into note_templates(name,schema) values ('X','{}')")).rejects.toThrow(/row-level security/);
    expect((await c.query("update note_templates set name='X'")).rowCount).toBe(0); // no update policy: rows are invisible to UPDATE
    expect((await c.query("delete from note_templates")).rowCount).toBe(0);
  });
  expect((await c.query("select count(*)::int n from note_templates where name='X'")).rows[0].n).toBe(0);
}));
