import { it, expect, describe } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

// migration 0008: buffer check, portal_invited_at, ensure_patient_record(), booking cap, horizon and buffers for non-staff

const GUARD = /protected patient columns can only be changed by staff/;
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
const dupTasks = async (c: Client) => (await c.query("select title, priority, source, patient_id from tasks where source='duplicate_patient'")).rows;
/** a staff-created patient row (no account yet); invited to the portal unless overridden */
const prospect = async (c: Client, email: string, o: { invited?: boolean; minor?: boolean; status?: string } = {}) =>
  (await c.query(
    "insert into patients(first_name,last_name,email,portal_invited_at,is_minor,status) values ('Sipho','Nkosi',$1,$2,$3,$4) returning id",
    [email, o.invited === false ? null : new Date(), o.minor ?? false, o.status ?? "prospect"])).rows[0].id as string;

describe("session_types.buffer_min", () => {
  it("rejects a negative buffer, allows zero", () => withClient(async (c) => {
    await expect(c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('x',50,1,-1)")).rejects.toThrow(/session_types_buffer_nonneg/);
    await c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('x',50,1,0)");
    await expect(c.query("update session_types set buffer_min=-5")).rejects.toThrow(/session_types_buffer_nonneg/);
  }));
});

describe("patients.portal_invited_at", () => {
  it("is null by default; a patient cannot set it (exact guard message); staff can", () => withClient(async (c) => {
    const u = await named(c, "Lerato Dube", "lerato@example.test");
    const id = await ensure(c, u);
    expect((await patientRows(c, "id=$1", [id]))[0].portal_invited_at).toBeNull();
    await asUser(c, u, async () => {
      await expect(c.query("update patients set portal_invited_at=now() where id=$1", [id])).rejects.toThrow(GUARD);
    });
    expect((await patientRows(c, "id=$1", [id]))[0].portal_invited_at).toBeNull();
    const psy = await mkUser(c, "psychologist");
    await asUser(c, psy, () => c.query("update patients set portal_invited_at=now() where id=$1", [id]));
    expect((await patientRows(c, "id=$1", [id]))[0].portal_invited_at).not.toBeNull();
  }));

  it("a patient still cannot link themself to an unlinked row or change their own user_id with a direct update", () => withClient(async (c) => {
    const pre = await prospect(c, "sipho@example.test");
    const u = await named(c, "Mallory", "other@example.test", true);
    const mine = await ensure(c, u);
    const res = await asUser(c, u, () => c.query("update patients set user_id=$2 where id=$1", [pre, u]));
    expect(res.rowCount).toBe(0); // RLS: not visible/updatable
    const other = await mkUser(c, "patient");
    await asUser(c, u, async () => {
      await expect(c.query("update patients set user_id=$2 where id=$1", [mine, other])).rejects.toThrow(GUARD);
    });
    expect((await patientRows(c, "id=$1", [pre]))[0].user_id).toBeNull();
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
    expect(await dupTasks(c)).toEqual([]); // no email match -> no review task
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

  it("links an INVITED single match when the account's email is confirmed (case and surrounding spaces ignored), and stays idempotent", () => withClient(async (c) => {
    const pre = await prospect(c, "  Sipho@Example.test ");
    const u = await named(c, "Sipho Nkosi", "sipho@example.test", true);
    expect(await ensure(c, u)).toBe(pre);
    expect(await ensure(c, u)).toBe(pre);
    expect((await patientRows(c, "email ilike '%sipho@example.test%'")).map((r) => r.user_id)).toEqual([u]);
    expect((await patientRows(c)).length).toBe(1);
    expect((await c.query("select action from audit_log where entity_id=$1", [pre])).rows).toEqual([{ action: "patient.link_account" }]);
    expect(await dupTasks(c)).toEqual([]);
  }));

  // Every case below must NOT link: a new prospect row is created for the caller and one review task is raised (once).
  const notLinked: [string, (c: Client) => Promise<string[]>, boolean][] = [
    ["not invited", async (c) => [await prospect(c, "sipho@example.test", { invited: false })], true],
    ["a minor", async (c) => [await prospect(c, "sipho@example.test", { minor: true })], true],
    ["archived", async (c) => [await prospect(c, "sipho@example.test", { status: "archived" })], true],
    ["two rows match", async (c) => [await prospect(c, "sipho@example.test"), await prospect(c, "SIPHO@example.test ")], true],
    ["an invited row plus a not-invited one", async (c) => [await prospect(c, "sipho@example.test"), await prospect(c, "sipho@example.test", { invited: false })], true],
    ["the account's email is unconfirmed", async (c) => [await prospect(c, "sipho@example.test")], false],
  ];
  for (const [why, mk, confirmed] of notLinked) {
    it(`does not link when ${why}: creates a new row and one duplicate-review task`, () => withClient(async (c) => {
      const pre = await mk(c);
      const u = await named(c, "Mallory Smith", "sipho@example.test", confirmed);
      const id = await ensure(c, u);
      expect(pre).not.toContain(id);
      expect(await ensure(c, u)).toBe(id); // idempotent: still one task
      for (const p of pre) expect((await patientRows(c, "id=$1", [p]))[0].user_id, "prospect untouched").toBeNull();
      expect((await patientRows(c, "id=$1", [id]))[0]).toMatchObject({ user_id: u, status: "prospect" });
      expect(await dupTasks(c)).toEqual([{ title: "Possible duplicate patient: review and merge", priority: "high", source: "duplicate_patient", patient_id: id }]);
    }));
  }

  it("never links a row that already belongs to another account", () => withClient(async (c) => {
    const owner = await named(c, "Owner One", "shared@example.test", true);
    const ownerRow = await ensure(c, owner);
    await c.query("update patients set portal_invited_at=now() where id=$1", [ownerRow]);
    const other = await named(c, "Other Two", "SHARED@example.test", true);
    const otherRow = await ensure(c, other);
    expect(otherRow).not.toBe(ownerRow);
    expect((await patientRows(c, "id=$1", [ownerRow]))[0].user_id).toBe(owner);
    expect(await dupTasks(c)).toEqual([]); // a linked row is not an "unlinked match"
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

describe("booking limits for non-staff", () => {
  /** practice open every day 08:00-17:00 SAST; day(n) = n days from today (SAST) at 10:00 SAST = 08:00Z */
  async function seed(c: Client) {
    const psy = await mkUser(c, "psychologist");
    const t = (await c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('Therapy',50,95000,10) returning id")).rows[0].id;
    const u = await mkUser(c, "patient");
    const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','One') returning id", [u])).rows[0].id;
    await c.query("update practices set approval_mode='auto'");
    for (let d = 0; d < 7; d++) await c.query("insert into availability_rules(weekday,start_time,end_time) values ($1,'08:00','17:00')", [d]);
    const today: string = (await c.query("select (now() at time zone 'Africa/Johannesburg')::date::text d")).rows[0].d;
    const date = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
    const day = (n: number, hhmm = "08:00") => `${date(n)}T${hhmm}:00Z`;
    return { psy, t, u, p, day };
  }
  const bookAs = (c: Client, u: string, p: string, t: string, at: string) =>
    asUser(c, u, async () => (await c.query("select book_appointment($1,$2,$3) id", [p, t, at])).rows[0].id as string);
  const staffBook = (c: Client, psy: string, p: string, t: string, at: string, status = "confirmed") =>
    asUser(c, psy, async () => (await c.query("select book_appointment($1,$2,$3,$4) id", [p, t, at, status])).rows[0].id as string);

  describe("cap", () => {
    it("allows 5 self-made future bookings and rejects the 6th; cancelling one frees a place", () => withClient(async (c) => {
      const { t, u, p, day } = await seed(c);
      const ids: string[] = [];
      for (let n = 2; n <= 6; n++) ids.push(await bookAs(c, u, p, t, day(n)));
      await expect(bookAs(c, u, p, t, day(7))).rejects.toThrow(/too_many_bookings/);
      await asUser(c, u, () => c.query("select cancel_appointment($1,'x')", [ids[0]]));
      await bookAs(c, u, p, t, day(7));
    }));

    it("counts tentative too, ignores cancelled, attended and past appointments", () => withClient(async (c) => {
      const { t, u, p, day } = await seed(c);
      await c.query("update practices set approval_mode='request'");
      for (let n = 2; n <= 4; n++) expect((await c.query("select status from appointments where id=$1", [await bookAs(c, u, p, t, day(n))])).rows[0].status).toBe("tentative");
      // rows made by the caller (events actor = u) in states that must not count
      const mk = async (at: string, status: string) => {
        const id = await bookAs(c, u, p, t, at);
        if (status === "attended") await c.query("update appointments set status='confirmed' where id=$1", [id]); // tentative -> confirmed -> attended (0009 state machine)
        await c.query("update appointments set status=$2 where id=$1", [id, status]);
      };
      await mk(day(10), "cancelled");
      await mk(day(11), "attended");
      await bookAs(c, u, p, t, day(5));
      await bookAs(c, u, p, t, day(6));
      await expect(bookAs(c, u, p, t, day(7))).rejects.toThrow(/too_many_bookings/);
    }));

    it("staff-made appointments never count against a patient: 8 staff bookings, then the patient can still book 5 (not 6)", () => withClient(async (c) => {
      const { psy, t, u, p, day } = await seed(c);
      for (let n = 20; n < 28; n++) await staffBook(c, psy, p, t, day(n));
      for (let n = 2; n <= 6; n++) await bookAs(c, u, p, t, day(n));
      await expect(bookAs(c, u, p, t, day(7))).rejects.toThrow(/too_many_bookings/);
      expect((await c.query("select count(*)::int n from appointments")).rows[0].n).toBe(13);
    }));

    it("staff are exempt from the cap", () => withClient(async (c) => {
      const { psy, t, p, day } = await seed(c);
      for (let n = 2; n < 10; n++) await staffBook(c, psy, p, t, day(n));
      expect((await c.query("select count(*)::int n from appointments")).rows[0].n).toBe(8);
    }));

    it("the cap is per caller, not global", () => withClient(async (c) => {
      const { t, u, p, day } = await seed(c);
      const u2 = await mkUser(c, "patient");
      const p2 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','Two') returning id", [u2])).rows[0].id;
      for (let n = 2; n <= 6; n++) await bookAs(c, u, p, t, day(n));
      await bookAs(c, u2, p2, t, day(7));
    }));

    it("a guardian is capped per child: 5 for each of two children, a 6th for either is rejected", () => withClient(async (c) => {
      const { t, p, day } = await seed(c);
      const g = await mkUser(c, "guardian");
      const child2 = (await c.query("insert into patients(first_name,last_name,is_minor) values ('Kid','Two',true) returning id")).rows[0].id;
      for (const child of [p, child2]) await c.query("insert into guardianships(guardian_user_id,patient_id,permissions) values ($1,$2,'{\"book\":true}')", [g, child]);
      for (let n = 2; n <= 6; n++) await bookAs(c, g, p, t, day(n));
      for (let n = 7; n <= 11; n++) await bookAs(c, g, child2, t, day(n));
      await expect(bookAs(c, g, p, t, day(12))).rejects.toThrow(/too_many_bookings/);
      await expect(bookAs(c, g, child2, t, day(13))).rejects.toThrow(/too_many_bookings/);
    }));

    it("reschedule is never capped: a patient at the cap can move an appointment, and can move a staff-made one", () => withClient(async (c) => {
      const { psy, t, u, p, day } = await seed(c);
      const ids: string[] = [];
      for (let n = 2; n <= 6; n++) ids.push(await bookAs(c, u, p, t, day(n)));
      const nid = await asUser(c, u, async () => (await c.query("select reschedule_appointment($1,$2) id", [ids[0], day(20)])).rows[0].id);
      expect((await c.query("select status from appointments where id=$1", [nid])).rows[0].status).toBe("confirmed");
      // staff book 8 weekly sessions; the patient can still reschedule one
      const staffIds: string[] = [];
      for (let n = 30; n < 38; n++) staffIds.push(await staffBook(c, psy, p, t, day(n)));
      await asUser(c, u, () => c.query("select reschedule_appointment($1,$2)", [staffIds[0], day(45)]));
      expect((await c.query("select status from appointments where id=$1", [staffIds[0]])).rows[0].status).toBe("cancelled");
    }));

    it("assert_booking_cap is not callable by API roles", () => withClient(async (c) => {
      const { u, p } = await seed(c);
      await asUser(c, u, async () => { await expect(c.query("select assert_booking_cap($1)", [p])).rejects.toThrow(/permission denied for function assert_booking_cap/); });
    }));
  });

  describe("horizon", () => {
    it("non-staff may book up to 60 days ahead (practice timezone, inclusive) and not beyond; staff are exempt", () => withClient(async (c) => {
      const { psy, t, u, p, day } = await seed(c);
      await bookAs(c, u, p, t, day(60));
      await expect(bookAs(c, u, p, t, day(61))).rejects.toThrow(/beyond_horizon/);
      await staffBook(c, psy, p, t, day(61));
      await staffBook(c, psy, p, t, day(400));
    }));

    it("reschedule is subject to the horizon too", () => withClient(async (c) => {
      const { t, u, p, day } = await seed(c);
      const id = await bookAs(c, u, p, t, day(3));
      await expect(asUser(c, u, () => c.query("select reschedule_appointment($1,$2)", [id, day(61)]))).rejects.toThrow(/beyond_horizon/);
      expect((await c.query("select status from appointments where id=$1", [id])).rows[0].status).toBe("confirmed");
    }));
  });

  describe("buffers", () => {
    // session type: 50 min + 10 min buffer, like lib/booking/slots.ts: next free start after an 08:00Z-08:50Z appointment is 09:00Z
    it("a non-staff booking cannot sit inside the buffer of an existing appointment; touching the buffer edge is fine", () => withClient(async (c) => {
      const { psy, t, u, p, day } = await seed(c);
      await staffBook(c, psy, p, t, day(5, "08:00")); // 08:00Z-08:50Z
      const other = await mkUser(c, "patient");
      const po = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'C','Three') returning id", [other])).rows[0].id;
      await expect(bookAs(c, other, po, t, day(5, "08:50"))).rejects.toThrow(/slot_taken/);   // starts when the session ends: no buffer
      await expect(bookAs(c, other, po, t, day(5, "08:59"))).rejects.toThrow(/slot_taken/);
      await expect(bookAs(c, other, po, t, day(5, "07:05"))).rejects.toThrow(/slot_taken/);   // ends 07:55, buffer reaches 08:05
      await bookAs(c, other, po, t, day(5, "09:00"));                                          // exactly one buffer after
      await bookAs(c, u, p, t, day(5, "07:00"));                                               // ends 07:50, buffer ends 08:00
      // staff are exempt from buffers: inside the buffer of another staff booking is allowed (only a true overlap is refused)
      await staffBook(c, psy, p, t, day(9, "08:00"));
      await staffBook(c, psy, p, t, day(9, "08:50"));
      await expect(staffBook(c, psy, p, t, day(9, "08:30"))).rejects.toThrow(/slot_taken/);
    }));

    it("blocked time is widened by the buffer too (blocked_time wins over slot_taken)", () => withClient(async (c) => {
      const { psy, t, u, p, day } = await seed(c);
      await c.query("insert into blocked_times(starts_at,ends_at) values ($1,$2)", [day(6, "08:00"), day(6, "09:00")]);
      await expect(bookAs(c, u, p, t, day(6, "09:05"))).rejects.toThrow(/blocked_time/);
      await expect(bookAs(c, u, p, t, day(6, "07:05"))).rejects.toThrow(/blocked_time/);
      await bookAs(c, u, p, t, day(6, "09:10"));
      await staffBook(c, psy, p, t, day(6, "08:00")); // staff may book inside blocked time
    }));

    it("a zero-buffer session type allows back-to-back bookings", () => withClient(async (c) => {
      const { psy, u, p, day } = await seed(c);
      const t0 = (await c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('Zero',50,1,0) returning id")).rows[0].id;
      await staffBook(c, psy, p, t0, day(7, "08:00"));
      await bookAs(c, u, p, t0, day(7, "08:50"));
    }));

    it("reschedule respects buffers but may move into overlap with its own old slot", () => withClient(async (c) => {
      const { psy, t, u, p, day } = await seed(c);
      const mine = await bookAs(c, u, p, t, day(8, "08:00"));
      const p2 = (await c.query("insert into patients(first_name,last_name) values ('D','Four') returning id")).rows[0].id;
      await staffBook(c, psy, p2, t, day(8, "10:00")); // 10:00Z-10:50Z
      await expect(asUser(c, u, () => c.query("select reschedule_appointment($1,$2)", [mine, day(8, "09:15")]))).rejects.toThrow(/slot_taken/); // ends 10:05 + buffer
      expect((await c.query("select status from appointments where id=$1", [mine])).rows[0].status).toBe("confirmed");
      const nid = (await asUser(c, u, () => c.query("select reschedule_appointment($1,$2) id", [mine, day(8, "08:30")]))).rows[0].id; // overlaps its own old slot
      expect((await c.query("select starts_at from appointments where id=$1", [nid])).rows[0].starts_at.toISOString()).toBe(day(8, "08:30").replace(":00Z", ":00.000Z"));
    }));
  });
});
