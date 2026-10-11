import { it, expect } from "vitest";
import { withClient, asUser, mkUser } from "./helpers";

it("audit_log cannot be updated or deleted by anyone", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist");
  await c.query("insert into audit_log(actor_id,action,entity) values ($1,'x','y')", [psy]);
  await asUser(c, psy, async () => {
    await expect(c.query("update audit_log set action='z'")).rejects.toThrow();
    await expect(c.query("delete from audit_log")).rejects.toThrow();
  });
}));

it("a patient sees only their own patient row", () => withClient(async (c) => {
  const u1 = await mkUser(c, "patient"); const u2 = await mkUser(c, "patient");
  await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','One'),($2,'B','Two')", [u1, u2]);
  const rows = await asUser(c, u1, async () => (await c.query("select last_name from patients")).rows);
  expect(rows).toEqual([{ last_name: "One" }]);
}));

it("anon cannot call audit_write or the role helpers (R4)", () => withClient(async (c) => {
  await c.query("set local role anon");
  await expect(c.query("select audit_write('x','y',null)")).rejects.toThrow(/permission denied/);
  await expect(c.query("select auth_role()")).rejects.toThrow(/permission denied/);
}));

it("audit_write records the caller", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist");
  const rows = await asUser(c, psy, async () => {
    await c.query("select audit_write('login','session',null,'{\"a\":1}')");
    return (await c.query("select actor_id, role, action from audit_log")).rows;
  });
  expect(rows).toEqual([{ actor_id: psy, role: "psychologist", action: "login" }]);
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
