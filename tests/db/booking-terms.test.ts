import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";

// accept_booking_terms (0012): the booking page's terms checkbox. The exact call sequence of bookAppointment (app/(public)/book/actions.ts):
//   ensure_patient_record() -> accept_booking_terms(patient) -> book_appointment(patient, type, start)
// set_consent refuses a patient's grant without a submitted form (consent_needs_submission), so the booking flow has its own narrow door.

async function seed(c: Client) {
  const psy = await mkUser(c, "psychologist");
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents,buffer_min) values ('Therapy',50,95000,10) returning id")).rows[0].id as string;
  await c.query("update practices set approval_mode='auto', cancellation_window_hours=36, late_cancel_fee_cents=45000");
  for (let d = 0; d < 7; d++) await c.query("insert into availability_rules(weekday,start_time,end_time) values ($1,'08:00','17:00')", [d]);
  const today: string = (await c.query("select (now() at time zone 'Africa/Johannesburg')::date::text d")).rows[0].d;
  const day = (n: number) => `${new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10)}T08:00:00Z`;
  const u = await mkUser(c, "patient");
  const p = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','One') returning id", [u])).rows[0].id as string;
  return { psy, t, u, p, day };
}
const consents = async (c: Client, p: string) => (await c.query("select purpose, granted, granted_at, withdrawn_at, form_submission_id, template_version from consents where patient_id=$1 order by purpose", [p])).rows;
const accept = (c: Client, u: string, p: string) => asUser(c, u, () => c.query("select accept_booking_terms($1)", [p]));

it("the booking action's sequence works for a patient: ensure_patient_record, accept_booking_terms, book_appointment", () => withClient(async (c) => {
  const { t, u, p, day } = await seed(c);
  await asUser(c, u, async () => {
    const id = (await c.query("select ensure_patient_record() id")).rows[0].id;
    expect(id).toBe(p);
    await c.query("select accept_booking_terms($1)", [id]);
    const appt = (await c.query("select book_appointment($1,$2,$3) id", [id, t, day(3)])).rows[0].id;
    expect(appt).toBeTruthy();
  });
  expect(await consents(c, p)).toMatchObject([{ purpose: "financial_terms", granted: true, withdrawn_at: null, form_submission_id: null, template_version: null }]);
  expect((await c.query("select status from appointments where patient_id=$1", [p])).rows).toEqual([{ status: "confirmed" }]);
}));

it("the old call (set_consent granting financial_terms with no submission) is refused for a patient: that is why the action uses accept_booking_terms", () => withClient(async (c) => {
  const { u, p } = await seed(c);
  await expect(asUser(c, u, () => c.query("select set_consent($1,'financial_terms',true,null)", [p]))).rejects.toThrow(/consent_needs_submission/);
}));

it("a patient cannot accept for someone else's patient; a guardian needs permissions.book; staff may", () => withClient(async (c) => {
  const { psy, p } = await seed(c);
  const u2 = await mkUser(c, "patient");
  await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','Two')", [u2]);
  await expect(accept(c, u2, p)).rejects.toThrow(/forbidden/);
  const gNo = await mkUser(c, "guardian"), gYes = await mkUser(c, "guardian"), gOld = await mkUser(c, "guardian");
  await c.query("insert into guardianships(guardian_user_id,patient_id,permissions) values ($1,$3,'{\"book\":false,\"forms\":true}'), ($2,$3,'{\"book\":true}')", [gNo, gYes, p]);
  await c.query("insert into guardianships(guardian_user_id,patient_id,permissions,valid_to) values ($1,$2,'{\"book\":true}','2000-01-01')", [gOld, p]);
  for (const g of [gNo, gOld]) await expect(accept(c, g, p)).rejects.toThrow(/forbidden/);
  expect(await consents(c, p)).toEqual([]);
  await accept(c, gYes, p);
  expect((await consents(c, p)).map((r) => r.purpose)).toEqual(["financial_terms"]);
  await accept(c, psy, p);
  // no user at all, and the bookkeeper
  await expect(c.query("select accept_booking_terms($1)", [p])).rejects.toThrow(/forbidden/);
  const bk = await mkUser(c, "bookkeeper");
  await expect(accept(c, bk, p)).rejects.toThrow(/forbidden/);
}));

it("accepting twice is idempotent (granted_at kept); re-accepting after a withdrawal clears withdrawn_at", () => withClient(async (c) => {
  const { u, p } = await seed(c);
  await accept(c, u, p);
  await c.query("update consents set granted_at='2020-01-01T00:00:00Z' where patient_id=$1", [p]);
  await accept(c, u, p);
  const r = await consents(c, p);
  expect(r).toHaveLength(1);
  expect(r[0].granted_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  await asUser(c, u, () => c.query("select set_consent($1,'financial_terms',false,null)", [p])); // withdrawals stay free
  expect((await consents(c, p))[0]).toMatchObject({ granted: false });
  expect((await consents(c, p))[0].withdrawn_at).not.toBeNull();
  await accept(c, u, p);
  const again = (await consents(c, p))[0];
  expect(again.granted).toBe(true);
  expect(again.withdrawn_at).toBeNull();
}));

it("it records financial_terms only: no other purpose is created or can be chosen", () => withClient(async (c) => {
  const { u, p } = await seed(c);
  await accept(c, u, p);
  expect((await consents(c, p)).map((r) => r.purpose)).toEqual(["financial_terms"]);
  // the function takes only the patient; the internal core is not callable by anyone
  await expect(asUser(c, u, () => c.query("select accept_booking_terms($1, 'treatment')", [p]))).rejects.toThrow(/does not exist/);
  for (const q of ["select _set_consent_core($1,'treatment',true,null,null)"]) {
    await expect(asUser(c, u, () => c.query(q, [p])), q).rejects.toThrow(/permission denied/);
  }
  expect((await consents(c, p)).map((r) => r.purpose)).toEqual(["financial_terms"]);
  // anon cannot call it
  await c.query("set local role anon");
  await expect(c.query("select accept_booking_terms($1)", [p])).rejects.toThrow(/permission denied/);
  await c.query("reset role");
}));

it("the audit row carries the accepted terms (practice settings in force) and that it came from booking", () => withClient(async (c) => {
  const { u, p } = await seed(c);
  await accept(c, u, p);
  const a = (await c.query("select action, actor_id, entity_id, detail from audit_log where entity='consents' and entity_id=$1", [p])).rows;
  expect(a).toHaveLength(1);
  expect(a[0]).toMatchObject({ action: "consent.grant", actor_id: u });
  expect(a[0].detail).toMatchObject({ purpose: "financial_terms", granted: true, via: "booking", cancellation_window_hours: 36, late_cancel_fee_cents: 45000, acted_by_role: "patient" });
  // change the terms, accept again: the new terms are recorded
  await c.query("update practices set cancellation_window_hours=48, late_cancel_fee_cents=0");
  await accept(c, u, p);
  const b = (await c.query("select detail from audit_log where entity='consents' and entity_id=$1 order by id desc limit 1", [p])).rows[0].detail;
  expect(b).toMatchObject({ cancellation_window_hours: 48, late_cancel_fee_cents: 0 });
}));
