import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

// Risk-flag tasks (source 'risk_flag:<note id>') are clinical: psychologist only. Everything else about tasks (admin included) is unchanged (forms.test.ts).
const TITLE = "Risk flagged: professional assessment and follow-up required";
async function mk(c: Client) {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), bk = await mkUser(c, "bookkeeper"), assoc = await mkUser(c, "associate");
  const pu = await mkUser(c, "patient"), gu = await mkUser(c, "guardian");
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'P','Q') returning id", [pu])).rows[0].id;
  await c.query("insert into guardianships(guardian_user_id,patient_id) values ($1,$2)", [gu, p]);
  const tpl = (await c.query("select id from note_templates where name='SOAP'")).rows[0].id;
  const n = (await c.query("insert into clinical_notes(patient_id,template_id,author_id) values ($1,$2,$3) returning id", [p, tpl, psy])).rows[0].id;
  const n2 = (await c.query("insert into clinical_notes(patient_id,template_id,author_id) values ($1,$2,$3) returning id", [p, tpl, psy])).rows[0].id;
  return { psy, adm, bk, assoc, pu, gu, p, n, n2 };
}
const raise = (c: Client, u: string, note: string, level: string) => asUser(c, u, () => c.query("select raise_risk_task($1,$2,$3)", [note, level, TITLE]));
const task = async (c: Client, note: string) => (await c.query("select title, priority, status, assignee, meta from tasks where source=$1", [`risk_flag:${note}`])).rows;

it("admin, bookkeeper, associate, patient and guardian see no risk task; the psychologist sees it", () => withClient(async (c) => {
  const m = await mk(c);
  await raise(c, m.psy, m.n, "high");
  await c.query("insert into tasks(title,patient_id,source) values ('ordinary',$1,'something_else')", [m.p]);
  const count = (u: string) => asUser(c, u, async () => (await c.query("select source from tasks")).rows.map((r) => r.source as string | null));
  expect(await count(m.psy)).toEqual(expect.arrayContaining([`risk_flag:${m.n}`, "something_else"]));
  expect(await count(m.adm)).toEqual(["something_else"]); // ordinary tasks stay visible to the admin
  for (const u of [m.bk, m.assoc, m.pu, m.gu]) expect(await count(u)).toEqual([]);
}));

it("the admin cannot insert, change, delete or move a risk task, and the psychologist can", () => withClient(async (c) => {
  const m = await mk(c);
  await raise(c, m.psy, m.n, "moderate");
  const src = `risk_flag:${m.n}`;
  await expect(asUser(c, m.adm, () => c.query("insert into tasks(title,source) values ('x',$1)", [`risk_flag:${m.n2}`]))).rejects.toThrow(/row-level security/);
  expect((await asUser(c, m.adm, () => c.query("update tasks set status='done' where source=$1", [src]))).rowCount).toBe(0);
  expect((await asUser(c, m.adm, () => c.query("delete from tasks where source=$1", [src]))).rowCount).toBe(0);
  // an admin cannot turn an ordinary task into a risk task, or the other way round
  const ord = (await c.query("insert into tasks(title,source) values ('o','other') returning id")).rows[0].id;
  await expect(asUser(c, m.adm, () => c.query("update tasks set source=$2 where id=$1", [ord, `risk_flag:${m.n2}`]))).rejects.toThrow(/row-level security/);
  await expect(asUser(c, m.adm, () => c.query("select raise_risk_task($1,'high',$2)", [m.n, TITLE]))).rejects.toThrow(/note_not_found/); // the admin cannot even see the note
  expect(await task(c, m.n)).toHaveLength(1);
  expect((await asUser(c, m.psy, () => c.query("update tasks set status='done' where source=$1", [src]))).rowCount).toBe(1);
  expect((await asUser(c, m.psy, () => c.query("delete from tasks where source=$1", [src]))).rowCount).toBe(1);
}));

it("raising twice is a no-op: one task per note, assigned to the caller, the level kept in meta", () => withClient(async (c) => {
  const m = await mk(c);
  await raise(c, m.psy, m.n, "moderate"); await raise(c, m.psy, m.n, "moderate"); await raise(c, m.psy, m.n, "moderate");
  expect(await task(c, m.n)).toEqual([{ title: TITLE, priority: "high", status: "open", assignee: m.psy, meta: { level: "moderate" } }]);
  await raise(c, m.psy, m.n2, "high");
  expect((await c.query("select count(*)::int n from tasks where source like 'risk_flag:%'")).rows[0].n).toBe(2); // another note has its own task
  // the unique index holds even for a direct duplicate insert
  await expect(asUser(c, m.psy, () => c.query("insert into tasks(title,source) values ('dup',$1)", [`risk_flag:${m.n}`]))).rejects.toThrow(/duplicate key/);
}));

it("none and low raise nothing; a lower level never touches the task; a rise from moderate to high updates it and re-opens it", () => withClient(async (c) => {
  const m = await mk(c);
  await raise(c, m.psy, m.n, "none"); await raise(c, m.psy, m.n, "low");
  expect(await task(c, m.n)).toEqual([]);
  await raise(c, m.psy, m.n, "moderate");
  await asUser(c, m.psy, () => c.query("update tasks set status='done' where source=$1", [`risk_flag:${m.n}`]));
  await raise(c, m.psy, m.n, "moderate"); // same level, finished: not re-raised
  await raise(c, m.psy, m.n, "low");
  expect((await task(c, m.n))[0]).toMatchObject({ status: "done", meta: { level: "moderate" } });
  await raise(c, m.psy, m.n, "high"); // the level rose: re-opened, no second task
  expect(await task(c, m.n)).toEqual([{ title: TITLE, priority: "high", status: "open", assignee: m.psy, meta: { level: "high" } }]);
  await asUser(c, m.psy, () => c.query("update tasks set status='done' where source=$1", [`risk_flag:${m.n}`]));
  await raise(c, m.psy, m.n, "moderate"); // lowered and raised again below the recorded level: stays done
  expect((await task(c, m.n))[0]).toMatchObject({ status: "done", meta: { level: "high" } });
}));

it("raise_risk_task is not executable by anon", () => withClient(async (c) => {
  const m = await mk(c);
  await c.query("set local role anon");
  try { await expect(c.query("select raise_risk_task($1,'high',$2)", [m.n, TITLE])).rejects.toThrow(/permission denied/); } finally { await c.query("reset role"); }
}));
