import { describe, it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

// 0010: the late-cancellation fee task is created by cancel_appointment itself (same transaction), and a patient cannot dodge the
// fee by rescheduling an appointment that is already inside the cancellation window.
const HOURS = (h: number) => `now() + interval '${h} hours'`;

async function seed(c: Client, o: { windowH?: number; feeCents?: number } = {}) {
  await c.query("update practices set cancellation_window_hours=$1, late_cancel_fee_cents=$2, approval_mode='auto'", [o.windowH ?? 24, o.feeCents ?? 35000]);
  const psy = await mkUser(c, "psychologist"); const pat = await mkUser(c, "patient");
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('Therapy',50,95000,0) returning id")).rows[0].id;
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','B') returning id", [pat])).rows[0].id;
  await c.query("insert into availability_rules(weekday,start_time,end_time) select d,'00:00','23:59' from generate_series(0,6) d");
  const appt = async (startsInHours: number, status = "confirmed") => (await c.query(
    `insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2,${HOURS(startsInHours)},${HOURS(startsInHours)} + interval '50 min',$3) returning id`, [p, t, status])).rows[0].id as string;
  return { psy, pat, t, p, appt };
}
const feeTasks = async (c: Client, id?: string) =>
  (await c.query("select * from tasks where source='late_cancel_fee' and ($1::uuid is null or appointment_id=$1)", [id ?? null])).rows;
const cancel = (c: Client, who: string, id: string, ...extra: unknown[]) =>
  asUser(c, who, () => c.query(extra.length ? "select cancel_appointment($1,'x',$2)" : "select cancel_appointment($1,'x')", [id, ...extra]));

describe("cancel_appointment creates the late fee task", () => {
  it("a late patient cancel creates exactly one task with the right fields, and an audit row", () => withClient(async (c) => {
    const { pat, p, appt } = await seed(c);
    const id = await appt(3);
    await cancel(c, pat, id);
    const tasks = await feeTasks(c, id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Late cancellation: review fee", priority: "high", source: "late_cancel_fee", appointment_id: id, patient_id: p, status: "open" });
    const a = (await c.query("select actor_id, role, detail from audit_log where action='appointment.cancel' and entity_id=$1", [id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: pat, role: "patient", detail: { late: true, fee_cents: 35000, by_role: "patient" } });
  }));

  it("an early patient cancel creates no task (audit says late false)", () => withClient(async (c) => {
    const { pat, appt } = await seed(c);
    const id = await appt(30);
    await cancel(c, pat, id);
    expect(await feeTasks(c)).toHaveLength(0);
    expect((await c.query("select detail from audit_log where action='appointment.cancel' and entity_id=$1", [id])).rows[0].detail).toMatchObject({ late: false, fee_cents: 0 });
  }));

  it("exactly at the window edge is not late, one minute inside is", () => withClient(async (c) => {
    const { pat, appt } = await seed(c);
    const edge = await appt(24); // now() is frozen in the test transaction: starts_at - now() = 24h exactly
    await cancel(c, pat, edge);
    expect(await feeTasks(c)).toHaveLength(0);
    const inside = (await c.query(`insert into appointments(patient_id,session_type_id,starts_at,ends_at,status)
      select patient_id, session_type_id, now() + interval '23 hours 59 minutes', now() + interval '24 hours 49 minutes', 'confirmed' from appointments where id=$1 returning id`, [edge])).rows[0].id;
    await cancel(c, pat, inside);
    expect(await feeTasks(c, inside)).toHaveLength(1);
  }));

  it("a fee setting of 0 creates no task even when late", () => withClient(async (c) => {
    const { pat, appt } = await seed(c, { feeCents: 0 });
    await cancel(c, pat, await appt(2));
    expect(await feeTasks(c)).toHaveLength(0);
  }));

  it("a window of 0 hours is never late for an upcoming appointment", () => withClient(async (c) => {
    const { pat, appt } = await seed(c, { windowH: 0 });
    await cancel(c, pat, await appt(1));
    expect(await feeTasks(c)).toHaveLength(0);
  }));

  it("staff cancel: no task without p_charge_fee, one task with it; never when the fee setting is 0", () => withClient(async (c) => {
    const { psy, appt } = await seed(c);
    const a = await appt(2), b = await appt(5);
    await cancel(c, psy, a);
    expect(await feeTasks(c, a)).toHaveLength(0);
    await cancel(c, psy, b, true);
    expect(await feeTasks(c, b)).toHaveLength(1);
    expect((await c.query("select detail from audit_log where action='appointment.cancel' and entity_id=$1", [b])).rows[0].detail).toMatchObject({ fee_cents: 35000, by_role: "psychologist" });
    await c.query("update practices set late_cancel_fee_cents=0");
    const z = await appt(7);
    await cancel(c, psy, z, true);
    expect(await feeTasks(c, z)).toHaveLength(0);
  }));

  it("p_charge_fee is ignored for non-staff: it cannot create or avoid a fee task", () => withClient(async (c) => {
    const { pat, appt } = await seed(c);
    const early = await appt(40), late = await appt(2);
    await cancel(c, pat, early, true);
    expect(await feeTasks(c, early)).toHaveLength(0);
    await cancel(c, pat, late, false);
    expect(await feeTasks(c, late)).toHaveLength(1);
  }));

  it("a second cancel attempt fails and does not create a second task or audit row", () => withClient(async (c) => {
    const { pat, psy, appt } = await seed(c);
    const id = await appt(3);
    await cancel(c, pat, id);
    await expect(cancel(c, pat, id)).rejects.toThrow(/not_cancellable/);
    await expect(cancel(c, psy, id, true)).rejects.toThrow(/not_cancellable/);
    expect(await feeTasks(c, id)).toHaveLength(1);
    expect((await c.query("select count(*)::int n from audit_log where action='appointment.cancel' and entity_id=$1", [id])).rows[0].n).toBe(1);
  }));

  it("the database guarantees one fee task per appointment (unique index)", () => withClient(async (c) => {
    const { p, appt } = await seed(c);
    const id = await appt(3);
    const ins = () => c.query("insert into tasks(title,source,appointment_id,patient_id) values ('Late cancellation: review fee','late_cancel_fee',$1,$2)", [id, p]);
    await ins();
    await expect(ins()).rejects.toThrow(/duplicate key|unique/i);
    await c.query("insert into tasks(title,source,appointment_id,patient_id) values ('other','something_else',$1,$2)", [id, p]); // other sources unaffected
  }));

  it("a cancel that raises leaves no task behind", () => withClient(async (c) => {
    const { psy, appt } = await seed(c);
    const id = await appt(3, "attended");
    await expect(cancel(c, psy, id, true)).rejects.toThrow(/not_cancellable/);
    expect(await feeTasks(c)).toHaveLength(0);
  }));

  it("the old two-argument function is gone: one cancel_appointment signature, callable with two arguments", () => withClient(async (c) => {
    expect((await c.query("select count(*)::int n from pg_proc where proname='cancel_appointment'")).rows[0].n).toBe(1);
  }));
});

describe("reschedule_appointment inside the cancellation window", () => {
  it("a patient inside the window must cancel instead", () => withClient(async (c) => {
    const { pat, appt } = await seed(c);
    const id = await appt(3);
    await expect(asUser(c, pat, () => c.query(`select reschedule_appointment($1, ${HOURS(100)})`, [id]))).rejects.toThrow(/inside_cancellation_window/);
    expect((await c.query("select status from appointments where id=$1", [id])).rows[0].status).toBe("confirmed"); // untouched
    expect(await feeTasks(c)).toHaveLength(0);
  }));

  it("the same for a tentative appointment", () => withClient(async (c) => {
    const { pat, appt } = await seed(c);
    const id = await appt(3, "tentative");
    await expect(asUser(c, pat, () => c.query(`select reschedule_appointment($1, ${HOURS(100)})`, [id]))).rejects.toThrow(/inside_cancellation_window/);
  }));

  it("a patient outside the window can reschedule", () => withClient(async (c) => {
    const { pat, appt } = await seed(c);
    const id = await appt(30);
    const nid = (await asUser(c, pat, () => c.query(`select reschedule_appointment($1, ${HOURS(100)}) id`, [id]))).rows[0].id;
    expect(nid).toBeTruthy();
    expect((await c.query("select status from appointments where id=$1", [id])).rows[0].status).toBe("cancelled");
    expect(await feeTasks(c)).toHaveLength(0); // moving is not a fee event
  }));

  it("staff may reschedule inside the window", () => withClient(async (c) => {
    const { psy, appt } = await seed(c);
    const id = await appt(3);
    const nid = (await asUser(c, psy, () => c.query(`select reschedule_appointment($1, ${HOURS(100)}) id`, [id]))).rows[0].id;
    expect(nid).toBeTruthy();
    expect(await feeTasks(c)).toHaveLength(0);
  }));

  it("the fee cannot be dodged: reschedule far away is refused, then cancelling carries the fee", () => withClient(async (c) => {
    const { pat, appt } = await seed(c);
    const id = await appt(3);
    await expect(asUser(c, pat, () => c.query(`select reschedule_appointment($1, ${HOURS(200)})`, [id]))).rejects.toThrow(/inside_cancellation_window/);
    await cancel(c, pat, id);
    expect(await feeTasks(c, id)).toHaveLength(1);
  }));

  it("a window of 0 hours never blocks a reschedule of an upcoming appointment", () => withClient(async (c) => {
    const { pat, appt } = await seed(c, { windowH: 0 });
    const id = await appt(1);
    expect((await asUser(c, pat, () => c.query(`select reschedule_appointment($1, ${HOURS(100)}) id`, [id]))).rows[0].id).toBeTruthy();
  }));

  it("an appointment that has started is still refused as already_started (checked first)", () => withClient(async (c) => {
    const { pat, appt } = await seed(c);
    const id = await appt(-1);
    await expect(asUser(c, pat, () => c.query(`select reschedule_appointment($1, ${HOURS(100)})`, [id]))).rejects.toThrow(/already_started/);
  }));

  it("moving a legacy 'requested' appointment (staff) creates a tentative row, which the status machine accepts", () => withClient(async (c) => {
    const { psy, appt } = await seed(c);
    const id = await appt(50, "requested");
    const nid = (await asUser(c, psy, () => c.query(`select reschedule_appointment($1, ${HOURS(100)}) id`, [id]))).rows[0].id;
    expect((await c.query("select status from appointments where id=$1", [nid])).rows[0].status).toBe("tentative");
  }));
});
