import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, asService, mkUser } from "./helpers";

const DENIED = /append-only|permission denied/;
const auditCount = async (c: Client) => Number((await c.query("select count(*) from audit_log")).rows[0].count);

const mkPatients = async (c: Client) => {
  const u1 = await mkUser(c, "patient"); const u2 = await mkUser(c, "patient");
  await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','One'),($2,'B','Two')", [u1, u2]);
  return { u1, u2 };
};

it("audit_log is append-only for authenticated, service_role and even the owner", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist");
  await c.query("insert into audit_log(actor_id,action,entity) values ($1,'x','y')", [psy]);
  const stmts = ["update audit_log set action='z'", "delete from audit_log", "truncate audit_log"];
  for (const s of stmts) await expect(c.query(s)).rejects.toThrow(/append-only/); // owner/superuser
  await asUser(c, psy, async () => {
    for (const s of stmts) await expect(c.query(s)).rejects.toThrow(DENIED);
    expect(await auditCount(c)).toBe(1);
  });
  await asService(c, async () => {
    for (const s of stmts) await expect(c.query(s)).rejects.toThrow(DENIED);
    expect(await auditCount(c)).toBe(1);
  });
  expect(await auditCount(c)).toBe(1);
}));

it("audit_log rows cannot be forged by direct INSERT or by calling audit_write/audit_append (R25)", () => withClient(async (c) => {
  const pat = await mkUser(c, "patient"); const psy = await mkUser(c, "psychologist");
  for (const u of [pat, psy]) await asUser(c, u, async () => {
    await expect(c.query("insert into audit_log(actor_id,role,action) values ($1,'psychologist','forged')", [u]))
      .rejects.toThrow(/permission denied/);
    await expect(c.query("select audit_write('x','y',null)")).rejects.toThrow(/permission denied for function audit_write/);
    await expect(c.query("select audit_append($1,'psychologist','x','y',null,null)", [u]))
      .rejects.toThrow(/permission denied for function audit_append/);
  });
  expect(await auditCount(c)).toBe(0);
}));

it("a patient sees only their own patient row", () => withClient(async (c) => {
  const { u1 } = await mkPatients(c);
  const rows = await asUser(c, u1, async () => (await c.query("select last_name from patients")).rows);
  expect(rows).toEqual([{ last_name: "One" }]);
}));

it("anon cannot call audit_write, audit_append or the role helpers (R4)", () => withClient(async (c) => {
  await c.query("set local role anon");
  await expect(c.query("select audit_write('x','y',null)")).rejects.toThrow(/permission denied/);
  await expect(c.query("select audit_append(null,null,'x','y',null,null)")).rejects.toThrow(/permission denied/);
  await expect(c.query("select auth_role()")).rejects.toThrow(/permission denied/);
}));

it("audit_append (service_role only) records the supplied actor, role and detail", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist");
  const ent = "00000000-0000-0000-0000-0000000000aa";
  const rows = await asService(c, async () => {
    await c.query("select audit_append($1,'psychologist','auth.login','session',$2,'{\"a\":1}')", [psy, ent]);
    return (await c.query("select actor_id, role, action, entity, entity_id, detail from audit_log")).rows;
  });
  expect(rows).toEqual([{ actor_id: psy, role: "psychologist", action: "auth.login", entity: "session", entity_id: ent, detail: { a: 1 } }]);
}));

it("DB-internal definer callers still write audit rows after the audit_write revoke", () => withClient(async (c) => {
  // an invoker-rights trigger path would fail with 'permission denied for function audit_write'; the owner-run one must not.
  const psy = await mkUser(c, "psychologist");
  const { rows: [p] } = await c.query("insert into patients(first_name,last_name) values ('A','B') returning id");
  await asUser(c, psy, () => c.query("select set_consent($1,'treatment',true,null)", [p.id]));
  const r = (await c.query("select actor_id, role, action from audit_log")).rows;
  expect(r).toEqual([{ actor_id: psy, role: "psychologist", action: "consent.grant" }]);
}));

it("a guardian sees the patient they hold valid guardianship over, and no other", () => withClient(async (c) => {
  const g = await mkUser(c, "guardian");
  const { rows } = await c.query(
    "insert into patients(first_name,last_name,is_minor) values ('Kid','Mine',true),('Kid','Other',true),('Kid','Expired',true) returning id, last_name");
  const id = (n: string) => rows.find((r) => r.last_name === n).id;
  await c.query(
    "insert into guardianships(guardian_user_id,patient_id,valid_to) values ($1,$2,null),($1,$3,current_date - 1)",
    [g, id("Mine"), id("Expired")]);
  const seen = await asUser(c, g, async () => (await c.query("select last_name from patients")).rows);
  expect(seen).toEqual([{ last_name: "Mine" }]);
}));

it("a patient can edit allowed columns of their own row (language and reminder choices; contact details are staff-only since 0023)", () => withClient(async (c) => {
  const { u1 } = await mkPatients(c);
  const r = await asUser(c, u1, () => c.query("update patients set language='af', comms_prefs='{\"email\":false,\"sms\":true}' where user_id=$1", [u1]));
  expect(r.rowCount).toBe(1);
  expect((await c.query("select language, comms_prefs from patients where user_id=$1", [u1])).rows[0]).toEqual({ language: "af", comms_prefs: { email: false, sms: true } });
}));

it.each([
  ["status", "status='active'"],
  ["payer", "payer='medical_aid'"],
  ["is_minor", "is_minor=true"],
  ["patient_number", "patient_number=9999"],
  ["user_id", "user_id=gen_random_uuid()"],
  ["id", "id=gen_random_uuid()"],
  ["created_at", "created_at=now() - interval '1 year'"],
])("a patient cannot change protected column %s", (_n, set) => withClient(async (c) => {
  const { u1 } = await mkPatients(c);
  const before = (await c.query("select * from patients where user_id=$1", [u1])).rows[0];
  await asUser(c, u1, async () => {
    await expect(c.query(`update patients set ${set} where user_id=$1`, [u1])).rejects.toThrow();
  });
  expect((await c.query("select * from patients where user_id=$1", [u1])).rows[0]).toEqual(before);
}));

it("a patient cannot update another patient's row", () => withClient(async (c) => {
  const { u1 } = await mkPatients(c);
  const r = await asUser(c, u1, () => c.query("update patients set phone='1' where last_name='Two'"));
  expect(r.rowCount).toBe(0);
}));

it("a psychologist can change patient status", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist");
  await mkPatients(c);
  const r = await asUser(c, psy, () => c.query("update patients set status='active' where last_name='One'"));
  expect(r.rowCount).toBe(1);
}));

it("a patient cannot create a profile or escalate their own role", () => withClient(async (c) => {
  const pat = await mkUser(c, "patient");
  await asUser(c, pat, async () => {
    await expect(c.query("insert into profiles(user_id,role,display_name) values (gen_random_uuid(),'psychologist','x')")).rejects.toThrow();
    const r = await c.query("update profiles set role='psychologist' where user_id=$1", [pat]);
    expect(r.rowCount).toBe(0);
  });
  expect((await c.query("select role from profiles where user_id=$1", [pat])).rows[0].role).toBe("patient");
}));

it("every ordinary table in public has RLS enabled", () => withClient(async (c) => {
  const { rows } = await c.query(
    "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity");
  expect(rows).toEqual([]);
}));
