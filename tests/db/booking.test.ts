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
  await c.query("update practices set approval_mode='auto'");
  await c.query("insert into availability_rules(weekday,start_time,end_time) values (1,'08:00','17:00')"); // Mondays 08-17 SAST
  return { psy, t, ua, ub, pa, pb };
}
const book = async (c: Client, p: string, t: string, at = T0, status = "confirmed") =>
  (await c.query("select book_appointment($1,$2,$3,$4) id", [p, t, at, status])).rows[0].id as string;
const row = async (c: Client, id: string) => (await c.query("select * from appointments where id=$1", [id])).rows[0];
const MON = "2031-01-06"; // a Monday; 08:00-17:00 SAST = 06:00Z-15:00Z
const eventsFull = async (c: Client, id: string) =>
  (await c.query("select event, detail from appointment_events where appointment_id=$1 order by id", [id])).rows;
const insAppt = (c: Client, p: string, t: string, at: string, status: string) => c.query(
  "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,$3,$3::timestamptz + interval '50 min',$4) returning id", [p, t, at, status]);
async function seedGuardian(c: Client, permissions = '{"book":true}') {
  const s = await seedPatients(c);
  const g = await mkUser(c, "guardian");
  await c.query("insert into guardianships(guardian_user_id,patient_id,permissions) values ($1,$2,$3)", [g, s.pa, permissions]);
  return { ...s, g };
}
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

it("status is decided by the DB for non-staff (R19), staff may choose", () => withClient(async (c) => {
  const { psy, t, ua, pa } = await seedPatients(c);
  const patientBook = (at: string, status: string) => asUser(c, ua, async () => book(c, pa, t, at, status));
  await c.query("update practices set approval_mode='request'");
  expect((await row(c, await patientBook(T0, "confirmed"))).status).toBe("tentative");
  expect((await row(c, await patientBook("2030-01-07T10:00:00Z", "attended"))).status).toBe("tentative"); // junk ignored
  await c.query("update practices set approval_mode='auto'");
  expect((await row(c, await patientBook("2030-01-07T12:00:00Z", "tentative"))).status).toBe("confirmed");
  await asUser(c, psy, async () => {
    expect((await row(c, await book(c, pa, t, "2030-01-07T13:00:00Z", "tentative"))).status).toBe("tentative");
    expect((await row(c, await book(c, pa, t, "2030-01-07T14:00:00Z", "confirmed"))).status).toBe("confirmed");
    await expect(c.query("select book_appointment($1,$2,$3,'attended')", [pa, t, "2030-01-07T15:00:00Z"])).rejects.toThrow(/invalid_status/);
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
  const oe = await eventsFull(c, old); const ne = await eventsFull(c, nid);
  expect(oe.map((e) => e.event)).toEqual(["created", "status:cancelled", "rescheduled"]);
  expect(oe[2].detail.new_id).toBe(nid);
  expect([new Date(oe[2].detail.from).toISOString(), new Date(oe[2].detail.to).toISOString()])
    .toEqual(["2030-01-07T08:00:00.000Z", "2030-01-07T10:00:00.000Z"]);
  expect(ne.map((e) => e.event)).toEqual(["created"]);
  expect(ne[0].detail.rescheduled_from).toBe(old);
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

it("created event details carry status and start; one update changing both logs both", () => withClient(async (c) => {
  const { t, p } = await seed(c);
  const id = await book(c, p, t, T0, "tentative");
  const [created] = await eventsFull(c, id);
  expect([created.detail.status, new Date(created.detail.starts_at).toISOString()]).toEqual(["tentative", "2030-01-07T08:00:00.000Z"]);
  await c.query("update appointments set status='confirmed', starts_at='2030-01-07T09:00:00Z', ends_at='2030-01-07T09:50:00Z' where id=$1", [id]);
  expect(await events(c, id)).toEqual(["created", "status:confirmed", "rescheduled"]);
}));

it("appointments cannot be deleted, even by staff", () => withClient(async (c) => {
  const { psy, t, p } = await seed(c);
  const id = await book(c, p, t);
  await asUser(c, psy, async () => {
    await expect(c.query("delete from appointments where id=$1", [id])).rejects.toThrow(/cannot be deleted; cancel instead/);
  });
  await expect(c.query("delete from appointments where id=$1", [id])).rejects.toThrow(/cannot be deleted/);
  expect(await row(c, id)).toBeTruthy();
}));

it("busy_ranges rejects windows over 62 days", () => withClient(async (c) => {
  await expect(c.query("select * from busy_ranges('2030-01-01T00:00:00Z','2030-03-05T00:00:00Z')")).rejects.toThrow(/window_too_large/);
  await c.query("select * from busy_ranges('2030-01-01T00:00:00Z','2030-03-03T00:00:00Z')"); // exactly 61 days
}));

it("authenticated cannot call the internal helpers", () => withClient(async (c) => {
  const { ua } = await seedPatients(c);
  await asUser(c, ua, async () => {
    await expect(c.query("select assert_patient_access(gen_random_uuid())")).rejects.toThrow(/permission denied/);
    await expect(c.query("select assert_bookable(now(), now())")).rejects.toThrow(/permission denied/);
    await expect(c.query("select is_booking_staff()")).rejects.toThrow(/permission denied/);
  });
}));

it("attended and no_show appointments cannot be cancelled or rescheduled", () => withClient(async (c) => {
  const { psy, t, ua, pa } = await seedPatients(c);
  for (const [i, st] of ["attended", "no_show"].entries()) {
    const id = (await insAppt(c, pa, t, `${MON}T0${6 + i * 2}:00:00Z`, st)).rows[0].id;
    for (const who of [ua, psy]) await asUser(c, who, async () => {
      await expect(c.query("select cancel_appointment($1,null)", [id])).rejects.toThrow(/not_cancellable/);
      await expect(c.query("select reschedule_appointment($1,$2)", [id, `${MON}T12:00:00Z`])).rejects.toThrow(/not_reschedulable/);
    });
  }
}));

it("reschedule keeps a tentative status", () => withClient(async (c) => {
  const { t, ua, pa } = await seedPatients(c);
  const id = await book(c, pa, t, `${MON}T06:00:00Z`, "tentative"); // staff (superuser) books tentative
  const nid = await asUser(c, ua, async () => (await c.query("select reschedule_appointment($1,$2) id", [id, `${MON}T08:00:00Z`])).rows[0].id);
  expect((await row(c, nid)).status).toBe("tentative");
}));

it("guardian with permissions.book can book, reschedule and cancel; without it is forbidden", () => withClient(async (c) => {
  const { t, g, pa } = await seedGuardian(c);
  const { g: g2, pa: pa2, t: t2 } = await seedGuardian(c, '{"book":false,"forms":true}');
  await asUser(c, g, async () => {
    const id = await book(c, pa, t, `${MON}T06:00:00Z`);
    const nid = (await c.query("select reschedule_appointment($1,$2) id", [id, `${MON}T08:00:00Z`])).rows[0].id;
    await c.query("select cancel_appointment($1,'x')", [nid]);
    expect((await row(c, nid)).status).toBe("cancelled");
  });
  const other = await book(c, pa2, t2, `${MON}T10:00:00Z`);
  await asUser(c, g2, async () => {
    await expect(c.query("select book_appointment($1,$2,$3)", [pa2, t2, `${MON}T06:00:00Z`])).rejects.toThrow(/forbidden/);
    await expect(c.query("select cancel_appointment($1,null)", [other])).rejects.toThrow(/forbidden/);
    await expect(c.query("select reschedule_appointment($1,$2)", [other, `${MON}T12:00:00Z`])).rejects.toThrow(/forbidden/);
    expect((await c.query("select id from appointments")).rows).toEqual([{ id: other }]); // can still read
  });
}));

it("non-staff cannot book or reschedule into the past, blocked time or outside opening hours; staff can", () => withClient(async (c) => {
  const { psy, t, ua, pa } = await seedPatients(c);
  await c.query("insert into blocked_times(starts_at,ends_at) values ($1,$2)", [`${MON}T08:00:00Z`, `${MON}T09:00:00Z`]);
  const bad: [string, RegExp][] = [
    ["2020-01-06T06:00:00Z", /start_in_past/],
    [`${MON}T07:30:00Z`, /blocked_time/],          // ends inside block
    [`${MON}T08:30:00Z`, /blocked_time/],          // starts inside block
    [`${MON}T05:30:00Z`, /outside_hours/],         // 07:30 SAST
    [`${MON}T14:30:00Z`, /outside_hours/],         // ends 17:20 SAST
    ["2031-01-07T06:00:00Z", /outside_hours/],     // Tuesday, no rule
  ];
  const src = await book(c, pa, t, `${MON}T11:00:00Z`); // source for reschedule attempts (booked by superuser)
  await asUser(c, ua, async () => {
    for (const [at, re] of bad) {
      await expect(c.query("select book_appointment($1,$2,$3)", [pa, t, at])).rejects.toThrow(re);
      await expect(c.query("select reschedule_appointment($1,$2)", [src, at])).rejects.toThrow(re);
    }
    // boundaries are inside: starting right after the block (09:00Z) and ending before close (14:00Z-14:50Z)
    for (const at of [`${MON}T09:00:00Z`, `${MON}T14:00:00Z`]) {
      const id = await book(c, pa, t, at);
      await c.query("select cancel_appointment($1,null)", [id]); // free the slot for the staff checks below
    }
  });
  expect((await row(c, src)).status).toBe("confirmed");
  await asUser(c, psy, async () => {
    for (const [at] of bad) {
      const id = await book(c, pa, t, at, "confirmed");
      await c.query("select cancel_appointment($1,'cleanup')", [id]);
    }
    const nid = (await c.query("select reschedule_appointment($1,$2) id", [src, `${MON}T05:30:00Z`])).rows[0].id; // outside hours
    expect((await row(c, nid)).status).toBe("confirmed");
  });
}));

it("non-staff cannot cancel or reschedule an appointment that has already started; staff can cancel", () => withClient(async (c) => {
  const { psy, t, ua, pa } = await seedPatients(c);
  const past = (await insAppt(c, pa, t, "2020-01-06T06:00:00Z", "confirmed")).rows[0].id;
  await asUser(c, ua, async () => {
    await expect(c.query("select cancel_appointment($1,null)", [past])).rejects.toThrow(/already_started/);
    await expect(c.query("select reschedule_appointment($1,$2)", [past, `${MON}T06:00:00Z`])).rejects.toThrow(/already_started/);
  });
  expect((await row(c, past)).status).toBe("confirmed");
  await asUser(c, psy, async () => { await c.query("select cancel_appointment($1,'admin')", [past]); });
  expect((await row(c, past)).status).toBe("cancelled");
}));
