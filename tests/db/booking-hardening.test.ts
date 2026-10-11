import { it, expect, describe } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

// migration 0008: buffer check, ensure_patient_record(), per-caller booking cap

const setEmail = (c: Client, uid: string, email: string, confirmed: boolean) =>
  c.query("update auth.users set email=$2, email_confirmed_at=$3 where id=$1", [uid, email, confirmed ? new Date() : null]);
const named = async (c: Client, name: string, email: string, confirmed = true) => {
  const u = await mkUser(c, "patient", name);
  await setEmail(c, u, email, confirmed);
  return u;
};
const ensure = (c: Client, u: string) => asUser(c, u, async () => (await c.query("select ensure_patient_record() id")).rows[0].id as string);
const patientRows = async (c: Client, where = "true", args: unknown[] = []) =>
  (await c.query(`select * from patients where ${where} order by created_at`, args)).rows;

describe("session_types.buffer_min", () => {
  it("rejects a negative buffer, allows zero", () => withClient(async (c) => {
    await expect(c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('x',50,1,-1)")).rejects.toThrow(/session_types_buffer_nonneg/);
    await c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('x',50,1,0)");
    await expect(c.query("update session_types set buffer_min=-5")).rejects.toThrow(/session_types_buffer_nonneg/);
  }));
});

describe("ensure_patient_record", () => {
  it("creates the caller's patient row once, from profile and auth email, and is idempotent", () => withClient(async (c) => {
    const u = await named(c, "Thandi Mokoena", "Thandi@Example.test");
    const id = await ensure(c, u);
    expect(await ensure(c, u)).toBe(id);
    const rows = await patientRows(c, "user_id=$1", [u]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, first_name: "Thandi", last_name: "Mokoena", email: "Thandi@Example.test", status: "prospect", user_id: u });
  }));

  it("splits names: single word gets '-' as last name; extra words go to the last name", () => withClient(async (c) => {
    const one = await ensure(c, await named(c, "Cher", "cher@example.test"));
    const many = await ensure(c, await named(c, "  Anna  Maria van der Merwe ", "anna@example.test"));
    const r = await patientRows(c, "id = any($1)", [[one, many]]);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect([by[one].first_name, by[one].last_name]).toEqual(["Cher", "-"]);
    expect([by[many].first_name, by[many].last_name]).toEqual(["Anna", "Maria van der Merwe"]);
  }));

  it("the row is visible to its owner through RLS and the call is audited", () => withClient(async (c) => {
    const u = await named(c, "Lerato Dube", "lerato@example.test");
    const id = await ensure(c, u);
    const seen = await asUser(c, u, () => c.query("select id from patients"));
    expect(seen.rows.map((r) => r.id)).toEqual([id]);
    const a = await c.query("select action, actor_id from audit_log where entity_id=$1", [id]);
    expect(a.rows).toEqual([{ action: "patient.self_create", actor_id: u }]);
  }));

  it("links a staff-created prospect with the same email when the account's email is confirmed", () => withClient(async (c) => {
    const pre = (await c.query("insert into patients(first_name,last_name,email) values ('Sipho','Nkosi','Sipho@Example.test') returning id")).rows[0].id;
    const u = await named(c, "Sipho Nkosi", "sipho@example.test", true);
    expect(await ensure(c, u)).toBe(pre);
    expect((await patientRows(c, "lower(email)='sipho@example.test'")).map((r) => r.user_id)).toEqual([u]);
    const a = await c.query("select action from audit_log where entity_id=$1", [pre]);
    expect(a.rows).toEqual([{ action: "patient.link_account" }]);
  }));

  it("never links when the account's email is unconfirmed: creates a separate row and leaves the prospect untouched", () => withClient(async (c) => {
    const pre = (await c.query("insert into patients(first_name,last_name,email) values ('Sipho','Nkosi','sipho@example.test') returning id")).rows[0].id;
    const u = await named(c, "Mallory", "sipho@example.test", false);
    const id = await ensure(c, u);
    expect(id).not.toBe(pre);
    expect((await patientRows(c, "id=$1", [pre]))[0].user_id).toBeNull();
    expect((await patientRows(c, "id=$1", [id]))[0].user_id).toBe(u);
  }));

  it("never links a row that already belongs to another account", () => withClient(async (c) => {
    const owner = await named(c, "Owner One", "shared@example.test", true);
    const ownerRow = await ensure(c, owner);
    const other = await named(c, "Other Two", "SHARED@example.test", true);
    const otherRow = await ensure(c, other);
    expect(otherRow).not.toBe(ownerRow);
    expect((await patientRows(c, "id=$1", [ownerRow]))[0].user_id).toBe(owner);
  }));

  it("only role 'patient' may call it; anon cannot execute it", () => withClient(async (c) => {
    for (const role of ["psychologist", "admin", "bookkeeper", "associate", "guardian"]) {
      const u = await mkUser(c, role);
      await asUser(c, u, async () => { await expect(c.query("select ensure_patient_record()"), role).rejects.toThrow(/forbidden/); });
    }
    expect(await patientRows(c)).toHaveLength(0);
    await c.query("set local role anon");
    try { await expect(c.query("select ensure_patient_record()")).rejects.toThrow(/permission denied for function ensure_patient_record/); }
    finally { await c.query("reset role"); }
  }));

  it("a user with no profile is forbidden", () => withClient(async (c) => {
    const id = (await c.query("insert into auth.users(id,email) values (gen_random_uuid(),'np@t.test') returning id")).rows[0].id;
    await c.query("delete from profiles where user_id=$1", [id]);
    await asUser(c, id, async () => { await expect(c.query("select ensure_patient_record()")).rejects.toThrow(/forbidden/); });
  }));
});

describe("booking cap for non-staff", () => {
  const MONDAYS = ["2031-01-06", "2031-01-13", "2031-01-20", "2031-01-27", "2031-02-03", "2031-02-10", "2031-02-17"].map((d) => `${d}T08:00:00Z`);
  async function seed(c: Client) {
    const psy = await mkUser(c, "psychologist");
    const t = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('Therapy',50,95000) returning id")).rows[0].id;
    const u = await mkUser(c, "patient");
    const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','One') returning id", [u])).rows[0].id;
    await c.query("update practices set approval_mode='auto'");
    await c.query("insert into availability_rules(weekday,start_time,end_time) values (1,'08:00','17:00')");
    return { psy, t, u, p };
  }
  const book = (c: Client, u: string, p: string, t: string, at: string) =>
    asUser(c, u, async () => (await c.query("select book_appointment($1,$2,$3) id", [p, t, at])).rows[0].id as string);

  it("allows 5 future bookings and rejects the 6th with too_many_bookings", () => withClient(async (c) => {
    const { t, u, p } = await seed(c);
    const ids: string[] = [];
    for (const at of MONDAYS.slice(0, 5)) ids.push(await book(c, u, p, t, at));
    await expect(book(c, u, p, t, MONDAYS[5])).rejects.toThrow(/too_many_bookings/);
    // cancelling one frees a place
    await asUser(c, u, () => c.query("select cancel_appointment($1,'x')", [ids[0]]));
    await book(c, u, p, t, MONDAYS[5]);
  }));

  it("counts tentative too, ignores cancelled, attended and past appointments", () => withClient(async (c) => {
    const { t, u, p } = await seed(c);
    await c.query("update practices set approval_mode='request'");
    for (const at of MONDAYS.slice(0, 3)) expect((await c.query("select status from appointments where id=$1", [await book(c, u, p, t, at)])).rows[0].status).toBe("tentative");
    const ins = (at: string, status: string) => c.query(
      "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,$3,$3::timestamptz + interval '50 min',$4)", [p, t, at, status]);
    await ins("2031-03-03T08:00:00Z", "cancelled");
    await ins("2031-03-10T08:00:00Z", "attended");
    await ins("2020-01-06T08:00:00Z", "confirmed"); // in the past
    await ins("2020-01-13T08:00:00Z", "tentative");
    await book(c, u, p, t, MONDAYS[3]);
    await book(c, u, p, t, MONDAYS[4]);
    await expect(book(c, u, p, t, MONDAYS[5])).rejects.toThrow(/too_many_bookings/);
  }));

  it("staff are exempt", () => withClient(async (c) => {
    const { psy, t, p } = await seed(c);
    for (const at of MONDAYS) await asUser(c, psy, () => c.query("select book_appointment($1,$2,$3,'confirmed')", [p, t, at]));
    expect((await c.query("select count(*)::int n from appointments")).rows[0].n).toBe(7);
  }));

  it("the cap is per caller, not global", () => withClient(async (c) => {
    const { t, u, p } = await seed(c);
    const u2 = await mkUser(c, "patient");
    const p2 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','Two') returning id", [u2])).rows[0].id;
    for (const at of MONDAYS.slice(0, 5)) await book(c, u, p, t, at);
    await book(c, u2, p2, t, MONDAYS[5]);
  }));

  it("a guardian's cap covers every patient they act for", () => withClient(async (c) => {
    const { t, p } = await seed(c);
    const g = await mkUser(c, "guardian");
    await c.query("insert into guardianships(guardian_user_id,patient_id,permissions) values ($1,$2,'{\"book\":true}')", [g, p]);
    for (const at of MONDAYS.slice(0, 5)) await book(c, g, p, t, at);
    await expect(book(c, g, p, t, MONDAYS[5])).rejects.toThrow(/too_many_bookings/);
  }));

  it("reschedule at the cap works (net zero); reschedule while already over the cap is rejected", () => withClient(async (c) => {
    const { t, u, p } = await seed(c);
    const ids: string[] = [];
    for (const at of MONDAYS.slice(0, 5)) ids.push(await book(c, u, p, t, at));
    await asUser(c, u, () => c.query("select reschedule_appointment($1,$2)", [ids[0], "2031-04-07T08:00:00Z"]));
    // push the patient over the cap behind the function's back (owner insert), then try to move one
    await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,'2031-05-05T08:00:00Z','2031-05-05T08:50:00Z','confirmed')", [p, t]);
    await expect(asUser(c, u, () => c.query("select reschedule_appointment($1,$2)", [ids[1], "2031-06-02T08:00:00Z"]))).rejects.toThrow(/too_many_bookings/);
    expect((await c.query("select status from appointments where id=$1", [ids[1]])).rows[0].status).toBe("confirmed"); // untouched
  }));

  it("assert_booking_cap is not callable by API roles", () => withClient(async (c) => {
    const { u } = await seed(c);
    await asUser(c, u, async () => { await expect(c.query("select assert_booking_cap()")).rejects.toThrow(/permission denied for function assert_booking_cap/); });
  }));
});

it("a patient still cannot link themself to an unlinked row or change their own user_id with a direct update", () => withClient(async (c) => {
  const pre = (await c.query("insert into patients(first_name,last_name,email) values ('Sipho','Nkosi','sipho@example.test') returning id")).rows[0].id;
  const u = await named(c, "Mallory", "sipho@example.test", false); // unconfirmed: gets its own row, the prospect stays unlinked
  const mine = await ensure(c, u);
  const res = await asUser(c, u, () => c.query("update patients set user_id=$2 where id=$1", [pre, u]));
  expect(res.rowCount).toBe(0); // RLS: not visible/updatable
  const other = await mkUser(c, "patient");
  await asUser(c, u, async () => {
    await expect(c.query("update patients set user_id=$2 where id=$1", [mine, other])).rejects.toThrow(/protected patient columns|row-level security/);
  });
  expect((await patientRows(c, "id=$1", [pre]))[0].user_id).toBeNull();
}));
