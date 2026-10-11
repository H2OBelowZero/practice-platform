import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, asService, mkUser } from "./helpers";

// 0009: appointment status state machine. Appointments are inserted directly as the owner in the state under test
// (INSERT is not subject to the transition trigger), then updated as the actor under test.
const STATUSES = ["requested", "tentative", "confirmed", "attended", "no_show", "cancelled"] as const;
const ALLOWED: Record<string, string[]> = {
  requested: ["tentative", "cancelled"],
  tentative: ["confirmed", "cancelled"],
  confirmed: ["attended", "no_show", "cancelled"],
  attended: [], no_show: [], cancelled: [],
};

async function seed(c: Client) {
  const psy = await mkUser(c, "psychologist"); const adm = await mkUser(c, "admin"); const pat = await mkUser(c, "patient");
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('Therapy',50,95000) returning id")).rows[0].id;
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','B') returning id", [pat])).rows[0].id;
  let n = 0;
  const mk = async (status: string) => (await c.query(
    `insert into appointments(patient_id,session_type_id,starts_at,ends_at,status)
     values ($1,$2, '2031-03-03T06:00:00Z'::timestamptz + $3 * interval '1 day', '2031-03-03T06:50:00Z'::timestamptz + $3 * interval '1 day', $4) returning id`,
    [p, t, n++, status])).rows[0].id as string;
  return { psy, adm, pat, t, p, mk };
}
const setStatus = (c: Client, id: string, st: string) => c.query("update appointments set status=$2 where id=$1", [id, st]);
const statusOf = async (c: Client, id: string) => (await c.query("select status from appointments where id=$1", [id])).rows[0].status as string;

it("only the allowed transitions are possible, for staff and for the owner/service writers", () => withClient(async (c) => {
  const { psy, mk } = await seed(c);
  for (const from of STATUSES) for (const to of STATUSES) {
    if (from === to) continue;
    const id = await mk(from);
    const doit = () => asUser(c, psy, () => setStatus(c, id, to));
    if (ALLOWED[from].includes(to)) { await doit(); expect(await statusOf(c, id), `${from}->${to}`).toBe(to); }
    else {
      await expect(doit(), `${from}->${to}`).rejects.toThrow(/invalid_appointment_transition/);
      await expect(setStatus(c, id, to), `owner ${from}->${to}`).rejects.toThrow(/invalid_appointment_transition/);
      await expect(asService(c, () => setStatus(c, id, to)), `service ${from}->${to}`).rejects.toThrow(/invalid_appointment_transition/);
      expect(await statusOf(c, id)).toBe(from);
    }
  }
}));

it("terminal states never change, and a no-op status write is fine", () => withClient(async (c) => {
  const { psy, mk } = await seed(c);
  for (const st of ["attended", "no_show", "cancelled"]) {
    const id = await mk(st);
    await asUser(c, psy, () => c.query("update appointments set cancel_reason='note' where id=$1", [id])); // status untouched
    await asUser(c, psy, () => setStatus(c, id, st)); // same -> same
    expect(await statusOf(c, id)).toBe(st);
  }
}));

it("admin may mark attended and no_show as well", () => withClient(async (c) => {
  const { adm, mk } = await seed(c);
  const a = await mk("confirmed"), b = await mk("confirmed");
  await asUser(c, adm, () => setStatus(c, a, "attended")); await asUser(c, adm, () => setStatus(c, b, "no_show"));
  expect([await statusOf(c, a), await statusOf(c, b)]).toEqual(["attended", "no_show"]);
}));

it("only staff may mark attended or no_show: a non-staff user is refused even if a policy let them write", () => withClient(async (c) => {
  const { pat, mk } = await seed(c);
  // patients have no UPDATE policy; open one inside this rolled-back transaction to prove the trigger rule on its own
  await c.query("create policy tmp_open_update on appointments for update to authenticated using (true) with check (true)");
  const a = await mk("confirmed"), b = await mk("confirmed"), cc = await mk("confirmed");
  await expect(asUser(c, pat, () => setStatus(c, a, "attended"))).rejects.toThrow(/invalid_appointment_transition/);
  await expect(asUser(c, pat, () => setStatus(c, b, "no_show"))).rejects.toThrow(/invalid_appointment_transition/);
  await asUser(c, pat, () => setStatus(c, cc, "cancelled")); // cancelling stays allowed by the machine (RLS is the gate)
  expect([await statusOf(c, a), await statusOf(c, b), await statusOf(c, cc)]).toEqual(["confirmed", "confirmed", "cancelled"]);
}));

it("the service role (no end user) may mark attended", () => withClient(async (c) => {
  const { mk } = await seed(c);
  const id = await mk("confirmed");
  await asService(c, () => setStatus(c, id, "attended"));
  expect(await statusOf(c, id)).toBe("attended");
}));

it("times are frozen once attended or no_show, but free while confirmed", () => withClient(async (c) => {
  const { psy, mk } = await seed(c);
  const id = await mk("confirmed");
  await asUser(c, psy, () => c.query("update appointments set starts_at=starts_at + interval '1 hour', ends_at=ends_at + interval '1 hour' where id=$1", [id]));
  for (const st of ["attended", "no_show"]) {
    const x = await mk("confirmed");
    await asUser(c, psy, () => setStatus(c, x, st));
    await expect(asUser(c, psy, () => c.query("update appointments set starts_at=starts_at + interval '1 hour' where id=$1", [x]))).rejects.toThrow(/appointment_times_frozen/);
    await expect(c.query("update appointments set ends_at=ends_at + interval '10 min' where id=$1", [x])).rejects.toThrow(/appointment_times_frozen/);
    await asUser(c, psy, () => c.query("update appointments set cancel_reason='x' where id=$1", [x])); // other columns are not frozen here
  }
}));

it("the cancel and reschedule functions still work through the machine, for patient and staff", () => withClient(async (c) => {
  const { psy, pat, p, t } = await seed(c);
  await c.query("update practices set approval_mode='request'");
  await c.query("insert into availability_rules(weekday,start_time,end_time) select d,'08:00','17:00' from generate_series(0,6) d");
  const start = new Date(Date.now() + 5 * 86400_000); start.setUTCHours(8, 0, 0, 0); // 10:00 SAST, inside the rule
  const next = new Date(start.getTime() + 86400_000);
  const id = (await asUser(c, pat, () => c.query("select book_appointment($1,$2,$3) id", [p, t, start.toISOString()]))).rows[0].id;
  expect(await statusOf(c, id)).toBe("tentative");
  const moved = (await asUser(c, pat, () => c.query("select reschedule_appointment($1,$2) id", [id, next.toISOString()]))).rows[0].id;
  expect(await statusOf(c, id)).toBe("cancelled");
  await asUser(c, psy, () => setStatus(c, moved, "confirmed"));
  await asUser(c, psy, () => c.query("select cancel_appointment($1,'staff')", [moved]));
  expect(await statusOf(c, moved)).toBe("cancelled");
  await expect(asUser(c, pat, () => c.query("select cancel_appointment($1,'again')", [moved]))).rejects.toThrow(/not_cancellable/);
}));
