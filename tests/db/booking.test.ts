import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

const T0 = "2030-01-07T08:00:00Z";
async function seed(c: Client) {
  const psy = await mkUser(c, "psychologist");
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('Therapy',50,95000) returning id")).rows[0].id;
  const p = (await c.query("insert into patients(first_name,last_name) values ('A','B') returning id")).rows[0].id;
  return { psy, t, p };
}
/** two patient users, each with their own patient row */
async function seedPatients(c: Client) {
  const { psy, t } = await seed(c);
  const ua = await mkUser(c, "patient"); const ub = await mkUser(c, "patient");
  const pa = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','One') returning id", [ua])).rows[0].id;
  const pb = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','Two') returning id", [ub])).rows[0].id;
  return { psy, t, ua, ub, pa, pb };
}
const book = async (c: Client, p: string, t: string, at = T0, status = "confirmed") =>
  (await c.query("select book_appointment($1,$2,$3,$4) id", [p, t, at, status])).rows[0].id as string;
const row = async (c: Client, id: string) => (await c.query("select * from appointments where id=$1", [id])).rows[0];
const events = async (c: Client, id: string) =>
  (await c.query("select event from appointment_events where appointment_id=$1 order by id", [id])).rows.map((r) => r.event);

it("rejects overlapping confirmed appointments", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  await c.query("select book_appointment($1,$2,'2030-01-07T08:00:00Z')", [p, t]);
  await expect(c.query("select book_appointment($1,$2,'2030-01-07T08:30:00Z')", [p, t])).rejects.toThrow(/slot_taken/);
}));
it("allows a cancelled slot to be rebooked and records events", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  const id = (await c.query("select book_appointment($1,$2,'2030-01-07T08:00:00Z') id", [p, t])).rows[0].id;
  await c.query("update appointments set status='cancelled' where id=$1", [id]);
  await c.query("select book_appointment($1,$2,'2030-01-07T08:00:00Z')", [p, t]);
  const ev = await c.query("select event from appointment_events where appointment_id=$1 order by id", [id]);
  expect(ev.rows.map((r) => r.event)).toEqual(["created", "status:cancelled"]);
}));

it("book_appointment only accepts confirmed or tentative", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  for (const s of ["attended", "no_show", "cancelled", "requested", "bogus"])
    await expect(c.query("select book_appointment($1,$2,$3,$4)", [p, t, T0, s])).rejects.toThrow(/invalid_status/);
  await expect(c.query("select book_appointment($1,$2,$3,null)", [p, t, T0])).rejects.toThrow(/invalid_status/);
  expect((await row(c, await book(c, p, t, T0, "tentative"))).status).toBe("tentative");
}));

it("tentative blocks a slot; cancelled and requested do not", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  await book(c, p, t, T0, "tentative");
  await expect(c.query("select book_appointment($1,$2,$3)", [p, t, T0])).rejects.toThrow(/slot_taken/);
  const ins = (at: string, status: string) => c.query(
    "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,$3,$3::timestamptz + interval '50 min',$4)", [p, t, at, status]);
  await ins("2030-01-08T08:00:00Z", "cancelled");
  await ins("2030-01-09T08:00:00Z", "requested");
  await book(c, p, t, "2030-01-08T08:00:00Z");
  await book(c, p, t, "2030-01-09T08:00:00Z");
}));

it("unknown session type is rejected", () => withClient(async (c) => {
  const { p } = await seed(c);
  await expect(c.query("select book_appointment($1,gen_random_uuid(),$2)", [p, T0])).rejects.toThrow(/unknown_session_type/);
}));

it("a patient can book for themself but not for another patient", () => withClient(async (c) => {
  const { t, ua, pa, pb } = await seedPatients(c);
  const id = await asUser(c, ua, async () => {
    await expect(c.query("select book_appointment($1,$2,$3)", [pb, t, T0])).rejects.toThrow(/forbidden/);
    return book(c, pa, t);
  });
  expect((await row(c, id)).patient_id).toBe(pa);
  expect(await events(c, id)).toEqual(["created"]);
  expect((await c.query("select count(*)::int n from appointments")).rows[0].n).toBe(1);
}));

it("a patient cannot book as attended even for themself", () => withClient(async (c) => {
  const { t, ua, pa } = await seedPatients(c);
  await asUser(c, ua, async () => {
    await expect(c.query("select book_appointment($1,$2,$3,'attended')", [pa, t, T0])).rejects.toThrow(/invalid_status/);
  });
}));

it("patients cannot write appointments directly (RLS) but can read their own", () => withClient(async (c) => {
  const { t, ua, pa, pb } = await seedPatients(c);
  const mine = await book(c, pa, t); const theirs = await book(c, pb, t, "2030-01-07T10:00:00Z");
  await asUser(c, ua, async () => {
    expect((await c.query("select id from appointments")).rows).toEqual([{ id: mine }]);
    expect((await c.query("update appointments set status='cancelled' where id=$1", [mine])).rowCount).toBe(0);
    expect((await c.query("update appointments set status='attended' where id=$1", [theirs])).rowCount).toBe(0);
    expect((await c.query("delete from appointments where id=$1", [mine])).rowCount).toBe(0);
    await expect(c.query(
      "insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,$3,$3::timestamptz + interval '1 hour')",
      [pa, t, "2030-01-10T08:00:00Z"])).rejects.toThrow(/row-level security/);
    await expect(c.query("insert into appointment_events(appointment_id,event) values ($1,'x')", [mine])).rejects.toThrow(/row-level security/);
  });
  expect((await row(c, mine)).status).toBe("confirmed");
  expect((await row(c, theirs)).status).toBe("confirmed");
}));

it("cancel_appointment: patient cancels own, records who and why", () => withClient(async (c) => {
  const { t, ua, pa } = await seedPatients(c);
  const id = await book(c, pa, t);
  await asUser(c, ua, async () => { await c.query("select cancel_appointment($1,'feeling better')", [id]); });
  const r = await row(c, id);
  expect([r.status, r.cancelled_by, r.cancel_reason]).toEqual(["cancelled", ua, "feeling better"]);
  expect(await events(c, id)).toEqual(["created", "status:cancelled"]);
  expect((await c.query("select actor from appointment_events where appointment_id=$1 and event='status:cancelled'", [id])).rows[0].actor).toBe(ua);
  await book(c, pa, t); // slot freed
  await asUser(c, ua, async () => {
    await expect(c.query("select cancel_appointment($1,null)", [id])).rejects.toThrow(/not_cancellable/);
  });
}));

it("cancel_appointment: another patient is forbidden; staff may cancel; unknown id raises", () => withClient(async (c) => {
  const { psy, t, ub, pa } = await seedPatients(c);
  const id = await book(c, pa, t);
  await asUser(c, ub, async () => {
    await expect(c.query("select cancel_appointment($1,'x')", [id])).rejects.toThrow(/forbidden/);
  });
  expect((await row(c, id)).status).toBe("confirmed");
  await asUser(c, psy, async () => {
    await expect(c.query("select cancel_appointment(gen_random_uuid(),'x')")).rejects.toThrow(/unknown_appointment/);
    await c.query("select cancel_appointment($1,'clinic closed')", [id]);
  });
  expect((await row(c, id)).cancelled_by).toBe(psy);
}));

it("reschedule_appointment moves to the new slot and frees the old one", () => withClient(async (c) => {
  const { t, ua, pa } = await seedPatients(c);
  const old = await book(c, pa, t);
  const nid = await asUser(c, ua, async () => (await c.query("select reschedule_appointment($1,'2030-01-07T10:00:00Z') id", [old])).rows[0].id as string);
  expect(nid).not.toBe(old);
  const n = await row(c, nid);
  expect([n.status, n.patient_id, n.session_type_id, n.starts_at.toISOString(), n.ends_at.toISOString()])
    .toEqual(["confirmed", pa, t, "2030-01-07T10:00:00.000Z", "2030-01-07T10:50:00.000Z"]);
  const o = await row(c, old);
  expect([o.status, o.cancelled_by, o.cancel_reason]).toEqual(["cancelled", ua, "rescheduled"]);
  expect(await events(c, old)).toEqual(["created", "status:cancelled"]);
  expect(await events(c, nid)).toEqual(["created"]);
  await book(c, pa, t); // old slot is free again
}));

it("reschedule_appointment can shift into a slot overlapping its own", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  const old = await book(c, p, t);
  const nid = (await c.query("select reschedule_appointment($1,'2030-01-07T08:30:00Z') id", [old])).rows[0].id;
  expect((await row(c, old)).status).toBe("cancelled");
  expect((await row(c, nid)).status).toBe("confirmed");
}));

it("reschedule_appointment conflict leaves the original untouched", () => withClient(async (c) => {
  const { t, ua, pa, pb } = await seedPatients(c);
  const old = await book(c, pa, t);
  await book(c, pb, t, "2030-01-07T10:00:00Z");
  await asUser(c, ua, async () => {
    await expect(c.query("select reschedule_appointment($1,'2030-01-07T10:30:00Z')", [old])).rejects.toThrow(/slot_taken/);
  });
  expect((await row(c, old)).status).toBe("confirmed");
  expect(await events(c, old)).toEqual(["created"]);
  expect((await c.query("select count(*)::int n from appointments")).rows[0].n).toBe(2);
}));

it("reschedule_appointment: forbidden for other patients, not_reschedulable once cancelled", () => withClient(async (c) => {
  const { t, ua, ub, pa } = await seedPatients(c);
  const id = await book(c, pa, t);
  await asUser(c, ub, async () => {
    await expect(c.query("select reschedule_appointment($1,'2030-01-07T10:00:00Z')", [id])).rejects.toThrow(/forbidden/);
  });
  await asUser(c, ua, async () => {
    await c.query("select cancel_appointment($1,null)", [id]);
    await expect(c.query("select reschedule_appointment($1,'2030-01-07T10:00:00Z')", [id])).rejects.toThrow(/not_reschedulable/);
  });
}));

it("busy_ranges exposes only time ranges, also to anon; anon cannot use the other functions or tables", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  await book(c, p, t);
  await c.query("insert into blocked_times(starts_at,ends_at,reason) values ('2030-01-07T12:00:00Z','2030-01-07T13:00:00Z','lunch')");
  await c.query("set local role anon");
  try {
    const r = await c.query("select * from busy_ranges('2030-01-07T00:00:00Z','2030-01-08T00:00:00Z') order by starts_at");
    expect(r.fields.map((f) => f.name)).toEqual(["starts_at", "ends_at"]);
    expect(r.rows.map((x) => x.starts_at.toISOString())).toEqual(["2030-01-07T08:00:00.000Z", "2030-01-07T12:00:00.000Z"]);
    expect((await c.query("select * from appointments")).rows).toEqual([]);
    expect((await c.query("select * from blocked_times")).rows).toEqual([]);
    expect((await c.query("select * from session_types")).rowCount).toBe(1); // public catalogue
    for (const q of ["select book_appointment(gen_random_uuid(),gen_random_uuid(),now())",
      "select cancel_appointment(gen_random_uuid(),null)", "select reschedule_appointment(gen_random_uuid(),now())"])
      await expect(c.query(q)).rejects.toThrow(/permission denied/);
  } finally { await c.query("reset role"); }
}));
