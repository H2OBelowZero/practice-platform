import { it, expect, describe } from "vitest";
import type { Client } from "pg";
import { asUser, asService, mkUser, withClient } from "./helpers";

// 0023: contact details are staff-only; failed notifications raise one staff task; stale rows expire instead of being sent late;
// claim only the asked-for channels; SMS rows only while switched on; archived patients get no reminders; release keeps the attempt.
const GUARD = /protected patient columns can only be changed by staff/;

async function seed(c: Client, o: { status?: string; prefs?: string } = {}) {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), pat = await mkUser(c, "patient");
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('Standard',50,95000) returning id")).rows[0].id as string;
  const p = (await c.query(
    "insert into patients(user_id,first_name,last_name,email,phone,status,comms_prefs) values ($1,'A','B','a@b.test','0821234567',$2,$3::jsonb) returning id",
    [pat, o.status ?? "active", o.prefs ?? '{"email":true,"sms":true}'])).rows[0].id as string;
  return { psy, adm, pat, t, p };
}
type Seed = Awaited<ReturnType<typeof seed>>;
const appt = async (c: Client, s: Seed, offset: string, status = "confirmed") =>
  (await c.query(
    "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2, now() + $3::interval, now() + $3::interval + interval '1 minute', $4) returning id",
    [s.p, s.t, offset, status])).rows[0].id as string;
const enqueue = async (c: Client, sms = false) => (await asService(c, () => c.query("select enqueue_reminders($1) as n", [sms]))).rows[0].n as number;
const claim = async (c: Client, channels?: string[]) =>
  (await asService(c, () => c.query(channels ? "select * from claim_outbox(25, $1)" : "select * from claim_outbox()", channels ? [channels] : []))).rows;
const finish = (c: Client, id: number, ok: boolean, err: string | null) => asService(c, () => c.query("select finish_outbox($1,$2,$3)", [id, ok, err]));
const row = async (c: Client, id: number) => (await c.query("select * from notifications_outbox where id=$1", [id])).rows[0];
const mkRow = async (c: Client, o: { template?: string; channel?: string; key?: string | null; sendAfter?: string; status?: string; attempts?: number; claimedAgo?: string | null } = {}) =>
  Number((await c.query(
    `insert into notifications_outbox(channel,template,recipient,payload,dedupe_key,status,attempts,send_after,claimed_at)
     values ($1,$2,'x@y.test','{}',$3,$4,$5, now() + $6::interval, case when $7::text is null then null else now() - $7::interval end) returning id`,
    [o.channel ?? "email", o.template ?? "t", o.key ?? null, o.status ?? "pending", o.attempts ?? 0, o.sendAfter ?? "-1 minute", o.claimedAgo ?? null])).rows[0].id);
const failedTasks = async (c: Client) => (await c.query("select * from tasks where source like 'outbox_failed:%' order by source")).rows;

describe("patients.email / patients.phone are staff-only", () => {
  it("a patient cannot change their own email or phone through the API (exact guard message); nothing changes", () => withClient(async (c) => {
    const s = await seed(c);
    for (const set of ["email='evil@x.test'", "phone='0000000000'", "email=null", "phone=null", "email='evil@x.test', language='af'"]) {
      await asUser(c, s.pat, async () => { await expect(c.query(`update patients set ${set} where id=$1`, [s.p]), set).rejects.toThrow(GUARD); });
    }
    expect((await c.query("select email, phone, language from patients where id=$1", [s.p])).rows[0]).toEqual({ email: "a@b.test", phone: "0821234567", language: "en" });
  }));
  it("a patient can still change language and reminder choices; a no-op write of the same email is fine", () => withClient(async (c) => {
    const s = await seed(c);
    const r = await asUser(c, s.pat, () => c.query("update patients set language='af', comms_prefs='{\"email\":false,\"sms\":false}', email='a@b.test' where id=$1", [s.p]));
    expect(r.rowCount).toBe(1);
  }));
  it("psychologist and admin can change both; so can the service role", () => withClient(async (c) => {
    const s = await seed(c);
    await asUser(c, s.psy, () => c.query("update patients set email='new@b.test', phone='0831112222' where id=$1", [s.p]));
    await asUser(c, s.adm, () => c.query("update patients set email='newer@b.test' where id=$1", [s.p]));
    await asService(c, () => c.query("update patients set phone='0840000000' where id=$1", [s.p]));
    expect((await c.query("select email, phone from patients where id=$1", [s.p])).rows[0]).toEqual({ email: "newer@b.test", phone: "0840000000" });
  }));
  it("the invited-patient linking flow (ensure_patient_record) still works", () => withClient(async (c) => {
    const u = (await c.query(
      "insert into auth.users(id,email,instance_id,aud,role,email_confirmed_at) values (gen_random_uuid(),'sipho@example.test','00000000-0000-0000-0000-000000000000','authenticated','authenticated',now()) returning id")).rows[0].id as string;
    await c.query("insert into profiles(user_id,role,display_name) values ($1,'patient','Sipho Dlamini') on conflict (user_id) do update set role='patient'", [u]);
    const pre = (await c.query("insert into patients(first_name,last_name,email,phone,portal_invited_at) values ('Sipho','D','sipho@example.test','0821234567',now()) returning id")).rows[0].id as string;
    const id = (await asUser(c, u, () => c.query("select ensure_patient_record() as id"))).rows[0].id;
    expect(id).toBe(pre);
    expect((await c.query("select user_id, email, phone from patients where id=$1", [pre])).rows[0]).toEqual({ user_id: u, email: "sipho@example.test", phone: "0821234567" });
  }));
});

describe("a failed notification raises one staff task", () => {
  it("the 3rd failed attempt marks the row failed and creates ONE task: fixed title, no patient, template and channel in meta, no recipient", () => withClient(async (c) => {
    const s = await seed(c);
    const id = await mkRow(c, { template: "invoice_issued", attempts: 3, status: "sending", claimedAgo: "1 minute" });
    await finish(c, id, false, "provider_http_500");
    expect((await row(c, id)).status).toBe("failed");
    const t = await failedTasks(c);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ title: "Notification could not be sent", priority: "normal", status: "open", patient_id: null, appointment_id: null, source: `outbox_failed:${id}`, meta: { template: "invoice_issued", channel: "email" } });
    expect(JSON.stringify(t[0])).not.toMatch(/x@y\.test/);
    // visible to psychologist and admin, not to the patient
    const visible = (u: string) => asUser(c, u, async () => (await c.query("select 1 from tasks where source like 'outbox_failed:%'")).rowCount);
    expect(await visible(s.psy)).toBe(1);
    expect(await visible(s.adm)).toBe(1);
    expect(await visible(s.pat)).toBe(0);
  }));
  it("a retry that is not the last does not create a task; success creates none", () => withClient(async (c) => {
    const a = await mkRow(c, { attempts: 1, status: "sending", claimedAgo: "1 minute" });
    await finish(c, a, false, "provider_timeout");
    const b = await mkRow(c, { attempts: 1, status: "sending", claimedAgo: "1 minute" });
    await finish(c, b, true, null);
    expect(await failedTasks(c)).toEqual([]);
  }));
  it("a stuck row that used its attempts is failed and raises the task too; a repeat creates no second task", () => withClient(async (c) => {
    const id = await mkRow(c, { status: "sending", attempts: 3, claimedAgo: "30 minutes" });
    await claim(c);
    await claim(c);
    expect(await failedTasks(c)).toHaveLength(1);
    expect((await row(c, id)).last_error).toBe("stuck");
    // finish on an already-failed row is a no-op and adds nothing
    await finish(c, id, false, "x");
    expect(await failedTasks(c)).toHaveLength(1);
  }));
  it("an expired row raises NO task", () => withClient(async (c) => {
    await mkRow(c, { template: "booking_confirmed", sendAfter: "-49 hours" });
    await claim(c);
    expect(await failedTasks(c)).toEqual([]);
  }));
});

describe("claim_outbox expires stale rows instead of sending them late", () => {
  it("a reminder whose appointment is still confirmed and ahead is claimed", () => withClient(async (c) => {
    const s = await seed(c);
    const a = await appt(c, s, "24 hours");
    await enqueue(c);
    const got = await claim(c);
    expect(got.map((r) => r.dedupe_key)).toEqual([`reminder_24h:${a}`]);
  }));

  it("a reminder whose appointment was cancelled, or is no longer confirmed, expires (no email)", () => withClient(async (c) => {
    const s = await seed(c);
    const a = await appt(c, s, "24 hours");
    await enqueue(c, true);
    await c.query("update appointments set status='cancelled' where id=$1", [a]);
    expect(await claim(c, ["email", "sms"])).toEqual([]);
    const rows = (await c.query("select channel, status, last_error from notifications_outbox order by channel")).rows;
    expect(rows).toEqual([{ channel: "email", status: "failed", last_error: "expired" }, { channel: "sms", status: "failed", last_error: "expired" }]);
  }));

  it("a reminder whose appointment has already started expires", () => withClient(async (c) => {
    const s = await seed(c);
    const a = await appt(c, s, "24 hours");
    await enqueue(c);
    await c.query("update appointments set starts_at = now() - interval '5 minutes', ends_at = now() - interval '4 minutes' where id=$1", [a]);
    expect(await claim(c)).toEqual([]);
    expect((await c.query("select status, last_error from notifications_outbox")).rows).toEqual([{ status: "failed", last_error: "expired" }]);
  }));

  it("a reminder more than 2 hours past send_after expires; at 1h59 it is still sent", () => withClient(async (c) => {
    const s = await seed(c);
    const a1 = await appt(c, s, "24 hours"), a2 = await appt(c, s, "25 hours");
    await enqueue(c);
    await c.query("update notifications_outbox set send_after = now() - interval '2 hours 1 minute' where dedupe_key=$1", [`reminder_24h:${a1}`]);
    await c.query("update notifications_outbox set send_after = now() - interval '1 hour 59 minutes' where dedupe_key=$1", [`reminder_24h:${a2}`]);
    expect((await claim(c)).map((r) => r.dedupe_key)).toEqual([`reminder_24h:${a2}`]);
    expect((await c.query("select status, last_error from notifications_outbox where dedupe_key=$1", [`reminder_24h:${a1}`])).rows[0]).toEqual({ status: "failed", last_error: "expired" });
  }));

  it("the review scenario: the provider is configured two days later, so the old reminders expire and are not sent", () => withClient(async (c) => {
    const s = await seed(c);
    for (const off of ["23 hours", "24 hours", "25 hours"]) await appt(c, s, off);
    expect(await enqueue(c)).toBe(3);
    // two days pass with nobody claiming (no provider configured): the rows were due 48 hours ago and their appointments have since started
    await c.query("update notifications_outbox set send_after = send_after - interval '2 days'");
    await c.query("update appointments set starts_at = starts_at - interval '2 days', ends_at = ends_at - interval '2 days'");
    expect(await claim(c)).toEqual([]);
    expect((await c.query("select status, last_error, count(*)::int n from notifications_outbox group by 1,2")).rows).toEqual([{ status: "failed", last_error: "expired", n: 3 }]);
  }));

  it("booking and cancellation emails older than 48 hours expire; younger ones and other templates are sent", () => withClient(async (c) => {
    const old = [];
    for (const t of ["booking_confirmed", "booking_requested", "appointment_cancelled", "appointment_rescheduled"]) old.push(await mkRow(c, { template: t, sendAfter: "-49 hours" }));
    const young = await mkRow(c, { template: "booking_confirmed", sendAfter: "-47 hours" });
    const invoice = await mkRow(c, { template: "invoice_issued", sendAfter: "-30 days" }); // not time-limited
    const got = (await claim(c)).map((r) => Number(r.id)).sort((a, b) => a - b);
    expect(got).toEqual([young, invoice].sort((a, b) => a - b));
    for (const id of old) expect(await row(c, id)).toMatchObject({ status: "failed", last_error: "expired", attempts: 0 });
  }));

  it("a stuck 'sending' reminder for a cancelled appointment is expired, not re-sent", () => withClient(async (c) => {
    const s = await seed(c);
    const a = await appt(c, s, "24 hours");
    await enqueue(c);
    await c.query("update notifications_outbox set status='sending', attempts=1, claimed_at = now() - interval '11 minutes'");
    await c.query("update appointments set status='cancelled' where id=$1", [a]);
    expect(await claim(c)).toEqual([]);
    expect((await c.query("select status, last_error from notifications_outbox")).rows).toEqual([{ status: "failed", last_error: "expired" }]);
  }));
});

describe("channels", () => {
  it("claims email only by default; sms rows stay pending untouched while SMS is inactive; asking for both takes both", () => withClient(async (c) => {
    const e = await mkRow(c, { channel: "email" }), m = await mkRow(c, { channel: "sms" });
    void m;
    expect((await claim(c)).map((r) => Number(r.id))).toEqual([e]);
    expect(await row(c, m)).toMatchObject({ status: "pending", attempts: 0 });
    expect(await claim(c, ["email"])).toEqual([]);
    expect(await claim(c, [])).toEqual([]);
    expect((await claim(c, ["email", "sms"])).map((r) => Number(r.id))).toEqual([m]);
  }));
  it("a null channel list falls back to email", () => withClient(async (c) => {
    const e = await mkRow(c), m = await mkRow(c, { channel: "sms" });
    const got = (await asService(c, () => c.query("select * from claim_outbox(25, null)"))).rows;
    expect(got.map((r) => Number(r.id))).toEqual([e]);
    expect(await row(c, m)).toMatchObject({ status: "pending" });
  }));
});

describe("enqueue_reminders(p_sms)", () => {
  it("queues no SMS rows unless p_sms is true (default false)", () => withClient(async (c) => {
    const s = await seed(c);
    await appt(c, s, "24 hours");
    expect(await enqueue(c)).toBe(1);
    expect((await c.query("select channel from notifications_outbox")).rows).toEqual([{ channel: "email" }]);
    expect(await enqueue(c, true)).toBe(1); // the sms row is added later; the email row is not repeated
    expect((await c.query("select channel from notifications_outbox order by channel")).rows).toEqual([{ channel: "email" }, { channel: "sms" }]);
  }));
  it("archived patients get neither email nor SMS reminders; prospect and active do", () => withClient(async (c) => {
    const arch = await seed(c, { status: "archived" });
    await appt(c, arch, "24 hours");
    expect(await enqueue(c, true)).toBe(0);
    const prospect = await seed(c, { status: "prospect" });
    await appt(c, prospect, "24 hours 20 minutes");
    expect(await enqueue(c, true)).toBe(2);
  }));
});

describe("release_outbox", () => {
  it("hands a claimed row back as pending, due now, with the attempt not used; other rows are untouched", () => withClient(async (c) => {
    const id = await mkRow(c), sent = await mkRow(c, { status: "sent" });
    const [claimed] = await claim(c);
    expect(claimed).toMatchObject({ attempts: 1, status: "sending" });
    await asService(c, () => c.query("select release_outbox($1)", [id]));
    expect(await row(c, id)).toMatchObject({ status: "pending", attempts: 0, claimed_at: null });
    expect((await claim(c)).map((r) => Number(r.id))).toEqual([id]); // claimable again straight away
    await asService(c, () => c.query("select release_outbox($1)", [sent]));
    expect((await row(c, sent)).status).toBe("sent");
    await asService(c, () => c.query("select release_outbox(999999)")); // unknown id: nothing happens
  }));
  it("never goes below zero attempts", () => withClient(async (c) => {
    const id = await mkRow(c, { status: "sending", attempts: 0, claimedAgo: "1 minute" });
    await asService(c, () => c.query("select release_outbox($1)", [id]));
    expect((await row(c, id)).attempts).toBe(0);
  }));
});
