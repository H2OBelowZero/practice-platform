import { it, expect, describe } from "vitest";
import { Client } from "pg";
import { asUser, asService, mkUser, withClient } from "./helpers";
import { sastDate, sastDayShort, sastTime } from "../../lib/time";

// 0022: the outbox worker functions (claim / finish), the reminder queue and the overdue-invoice tasks.
// now() is frozen inside a test transaction, so appointment times are written as now() + an offset and "time passing" is simulated by
// moving send_after / claimed_at into the past.
type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(c: Client, opts: { email?: string | null; phone?: string | null; prefs?: string } = {}) {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), pat = await mkUser(c, "patient");
  const t = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('Standard',50,95000) returning id")).rows[0].id as string;
  const p = (await c.query(
    "insert into patients(user_id,first_name,last_name,email,phone,comms_prefs) values ($1,'A','B',$2,$3,$4::jsonb) returning id",
    [pat, opts.email === undefined ? "a@b.test" : opts.email, opts.phone === undefined ? "0821234567" : opts.phone, opts.prefs ?? '{"email":true,"sms":false}'])).rows[0].id as string;
  return { psy, adm, pat, t, p };
}
/** an appointment starting `interval` from now (1 minute long, so several never overlap) */
const appt = async (c: Client, s: Seed, offset: string, status = "confirmed") =>
  (await c.query(
    "insert into appointments(patient_id,session_type_id,starts_at,ends_at,status) values ($1,$2, now() + $3::interval, now() + $3::interval + interval '1 minute', $4) returning id",
    [s.p, s.t, offset, status])).rows[0].id as string;
const enqueue = async (c: Client) => (await asService(c, () => c.query("select enqueue_reminders() as n"))).rows[0].n as number;
const rows = async (c: Client, where = "true") => (await c.query(`select * from notifications_outbox where ${where} order by id`)).rows;
const mkRow = async (c: Client, o: { status?: string; attempts?: number; sendAfter?: string; claimedAgo?: string | null } = {}) =>
  Number((await c.query(
    `insert into notifications_outbox(channel,template,recipient,payload,status,attempts,send_after,claimed_at)
     values ('email','t','x@y.test','{}', $1, $2, now() + $3::interval, case when $4::text is null then null else now() - $4::interval end) returning id`,
    [o.status ?? "pending", o.attempts ?? 0, o.sendAfter ?? "-1 minute", o.claimedAgo ?? null])).rows[0].id);
const claim = async (c: Client, n?: number) =>
  (await asService(c, () => c.query(n === undefined ? "select * from claim_outbox()" : "select * from claim_outbox($1)", n === undefined ? [] : [n]))).rows;
const finish = (c: Client, id: number, ok: boolean, err: string | null) => asService(c, () => c.query("select finish_outbox($1,$2,$3)", [id, ok, err]));

describe("enqueue_reminders", () => {
  it("covers appointments starting 23h to 25h from now, both ends inclusive", () => withClient(async (c) => {
    const s = await seed(c);
    const out = await appt(c, s, "22 hours 59 minutes"), in1 = await appt(c, s, "23 hours");
    const in2 = await appt(c, s, "24 hours"), in3 = await appt(c, s, "25 hours"), late = await appt(c, s, "25 hours 1 minute");
    expect(await enqueue(c)).toBe(3);
    const keys = (await rows(c)).map((r) => r.dedupe_key).sort();
    expect(keys).toEqual([in1, in2, in3].map((id) => `reminder_24h:${id}`).sort());
    expect(keys).not.toContain(`reminder_24h:${out}`);
    expect(keys).not.toContain(`reminder_24h:${late}`);
  }));

  it("only confirmed appointments get one (not requested, tentative, cancelled, attended or no-show)", () => withClient(async (c) => {
    const s = await seed(c);
    let i = 0;
    for (const st of ["requested", "tentative", "cancelled", "attended", "no_show"]) await appt(c, s, `${24 * 60 + i++} minutes`, st);
    expect(await enqueue(c)).toBe(0);
    await appt(c, s, "24 hours 30 minutes", "confirmed");
    expect(await enqueue(c)).toBe(1);
  }));

  it("an appointment cancelled after its reminder was queued keeps its (already queued) row; one cancelled before gets none", () => withClient(async (c) => {
    const s = await seed(c);
    const id = await appt(c, s, "24 hours");
    expect(await enqueue(c)).toBe(1);
    await c.query("update appointments set status='cancelled' where id=$1", [id]);
    expect(await enqueue(c)).toBe(0);
    expect((await rows(c)).length).toBe(1);
  }));

  it("respects comms_prefs and missing contact details", () => withClient(async (c) => {
    // email off: nothing
    let s = await seed(c, { prefs: '{"email":false,"sms":false}' });
    await appt(c, s, "24 hours");
    expect(await enqueue(c)).toBe(0);
    // no email on record
    s = await seed(c, { email: null });
    await appt(c, s, "24 hours 10 minutes");
    expect(await enqueue(c)).toBe(0);
    s = await seed(c, { email: "   " });
    await appt(c, s, "24 hours 20 minutes");
    expect(await enqueue(c)).toBe(0);
    // preference keys missing / not true
    s = await seed(c, { prefs: "{}" });
    await appt(c, s, "24 hours 30 minutes");
    s = await seed(c, { prefs: '{"email":"yes"}' });
    await appt(c, s, "24 hours 40 minutes");
    expect(await enqueue(c)).toBe(0);
    expect((await rows(c)).length).toBe(0);
  }));

  it("queues an SMS row only when sms is on and a phone is on record; both channels when both are on", () => withClient(async (c) => {
    let s = await seed(c, { prefs: '{"email":false,"sms":true}' });
    const a1 = await appt(c, s, "24 hours");
    expect(await enqueue(c)).toBe(1);
    expect(await rows(c)).toMatchObject([{ channel: "sms", template: "reminder_24h_sms", recipient: "0821234567", dedupe_key: `reminder_24h_sms:${a1}`, status: "pending" }]);
    s = await seed(c, { prefs: '{"email":true,"sms":true}' });
    await appt(c, s, "24 hours 30 minutes");
    expect(await enqueue(c)).toBe(2);
    s = await seed(c, { prefs: '{"email":false,"sms":true}', phone: null });
    await appt(c, s, "23 hours 30 minutes");
    expect(await enqueue(c)).toBe(0);
  }));

  it("is idempotent: a second and third run (cron every 15 minutes) insert nothing", () => withClient(async (c) => {
    const s = await seed(c, { prefs: '{"email":true,"sms":true}' });
    await appt(c, s, "24 hours");
    expect(await enqueue(c)).toBe(2);
    expect(await enqueue(c)).toBe(0);
    expect(await enqueue(c)).toBe(0);
    expect((await rows(c)).length).toBe(2);
    // a sent reminder is not queued again either
    await c.query("update notifications_outbox set status='sent', sent_at=now()");
    expect(await enqueue(c)).toBe(0);
  }));

  it("the email row: recipient is the trimmed email, payload is date, time and a path only, formatted in SAST", () => withClient(async (c) => {
    const s = await seed(c, { email: "  Pat@Example.test " });
    await appt(c, s, "24 hours");
    await enqueue(c);
    const [r] = await rows(c);
    expect(r).toMatchObject({ channel: "email", template: "reminder_24h", recipient: "Pat@Example.test", status: "pending", attempts: 0 });
    expect(Object.keys(r.payload).sort()).toEqual(["date", "link", "time"]);
    expect(r.payload.link).toBe("/portal/appointments");
    // cross-check the SQL formatting against the app's own SAST helpers
    const starts = (await c.query("select starts_at from appointments where patient_id=$1", [s.p])).rows[0].starts_at as Date;
    expect(r.payload.date).toBe(sastDayShort(sastDate(starts), true));
    expect(r.payload.time).toBe(sastTime(starts));
    expect(r.payload.date).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    expect(r.payload.time).toMatch(/^\d{2}:\d{2}$/);
  }));

  it("sast_short_date formats in South African time across midnight and month ends", () => withClient(async (c) => {
    const f = async (iso: string) => (await asService(c, () => c.query("select sast_short_date($1::timestamptz) as d, to_char($1::timestamptz at time zone 'Africa/Johannesburg','HH24:MI') as t", [iso]))).rows[0];
    expect(await f("2030-01-06T22:30:00Z")).toEqual({ d: "Mon 7 Jan 2030", t: "00:30" }); // 22:30 UTC is already the next day in SAST
    expect(await f("2030-01-07T06:00:00Z")).toEqual({ d: "Mon 7 Jan 2030", t: "08:00" });
    expect(await f("2030-01-31T21:59:00Z")).toEqual({ d: "Thu 31 Jan 2030", t: "23:59" });
    expect(await f("2030-01-31T22:00:00Z")).toEqual({ d: "Fri 1 Feb 2030", t: "00:00" });
    expect(await f("2030-12-31T22:00:00Z")).toEqual({ d: "Wed 1 Jan 2031", t: "00:00" });
  }));
});

describe("claim_outbox / finish_outbox", () => {
  it("claims due pending rows only: send_after in the past, fewer than 3 attempts", () => withClient(async (c) => {
    const due = await mkRow(c), future = await mkRow(c, { sendAfter: "1 minute" }), spent = await mkRow(c, { attempts: 3 });
    const sent = await mkRow(c, { status: "sent" }), failed = await mkRow(c, { status: "failed" });
    const got = await claim(c);
    expect(got.map((r) => Number(r.id))).toEqual([due]);
    expect([future, spent, sent, failed].some((id) => got.some((r) => Number(r.id) === id))).toBe(false);
    expect(got[0]).toMatchObject({ status: "sending", attempts: 1, recipient: "x@y.test" });
    expect(got[0].claimed_at).toBeInstanceOf(Date);
    expect(await claim(c)).toEqual([]); // claimed rows are not handed out twice
  }));

  it("honours the limit (default 25, at most 100) and goes in send_after order", () => withClient(async (c) => {
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push(await mkRow(c, { sendAfter: `-${60 - i} minutes` }));
    expect((await claim(c)).length).toBe(25);
    const rest = await claim(c, 100);
    expect(rest.length).toBe(5);
    expect(rest.map((r) => Number(r.id))).toEqual(ids.slice(25));
    expect(await claim(c, 0)).toEqual([]); // nothing left; 0 is clamped to 1, not an error
  }));

  it("success marks the row sent with sent_at and clears the error", () => withClient(async (c) => {
    const id = await mkRow(c);
    await claim(c);
    await finish(c, id, true, null);
    expect((await rows(c, `id=${id}`))[0]).toMatchObject({ status: "sent", attempts: 1, last_error: null, claimed_at: null });
    expect((await rows(c, `id=${id}`))[0].sent_at).toBeInstanceOf(Date);
    await finish(c, id, false, "late"); // a finish for a row that is no longer claimed changes nothing
    expect((await rows(c, `id=${id}`))[0].status).toBe("sent");
  }));

  it("failure goes back to pending with a backoff of attempts x 10 minutes, then failed after 3 attempts", () => withClient(async (c) => {
    const id = await mkRow(c);
    const r = async () => (await c.query("select status, attempts, last_error, send_after - now() as wait from notifications_outbox where id=$1", [id])).rows[0];
    for (const [attempt, wait] of [[1, 10], [2, 20]] as const) {
      expect((await claim(c)).length, `claim ${attempt}`).toBe(1);
      await finish(c, id, false, "provider_http_500");
      const row = await r();
      expect(row).toMatchObject({ status: "pending", attempts: attempt, last_error: "provider_http_500" });
      expect(row.wait).toEqual({ minutes: wait }); // frozen now(): exactly attempts x 10 minutes
      expect(await claim(c), "not due yet").toEqual([]);
      await c.query("update notifications_outbox set send_after = now() - interval '1 second' where id=$1", [id]);
    }
    expect((await claim(c)).length).toBe(1);
    await finish(c, id, false, "provider_timeout");
    expect(await r()).toMatchObject({ status: "failed", attempts: 3, last_error: "provider_timeout" });
    await c.query("update notifications_outbox set send_after = now() - interval '1 hour' where id=$1", [id]);
    expect(await claim(c), "failed rows are never claimed").toEqual([]);
  }));

  it("stores only a short alphanumeric code, never free text", () => withClient(async (c) => {
    const id = await mkRow(c);
    await claim(c);
    await finish(c, id, false, "<html>Bad key for jane@example.test: {\"message\":\"nope\"}</html>");
    const e = (await rows(c, `id=${id}`))[0].last_error as string;
    expect(e).toMatch(/^[A-Za-z0-9_]{1,40}$/);
    expect(e).not.toMatch(/[@<>{}:" ]/);
    await c.query("update notifications_outbox set status='sending' where id=$1", [id]);
    await finish(c, id, false, "x".repeat(200));
    expect(((await rows(c, `id=${id}`))[0].last_error as string).length).toBe(40);
    await c.query("update notifications_outbox set status='sending' where id=$1", [id]);
    await finish(c, id, false, "  !! ");
    expect((await rows(c, `id=${id}`))[0].last_error).toBe("error");
    await c.query("update notifications_outbox set status='sending' where id=$1", [id]);
    await finish(c, id, false, null);
    expect((await rows(c, `id=${id}`))[0].last_error).toBe("error");
    // the table itself refuses anything but a code, even for the owner
    await expect(c.query("update notifications_outbox set last_error='has spaces' where id=$1", [id])).rejects.toThrow(/last_error_code/);
  }));

  it("re-claims a row stuck in 'sending' for more than 10 minutes, but not a fresh one", () => withClient(async (c) => {
    const fresh = await mkRow(c, { status: "sending", attempts: 1, claimedAgo: "9 minutes" });
    const stuck = await mkRow(c, { status: "sending", attempts: 1, claimedAgo: "11 minutes" });
    const got = await claim(c);
    expect(got.map((r) => Number(r.id))).toEqual([stuck]);
    expect(got[0]).toMatchObject({ status: "sending", attempts: 2 });
    expect((await rows(c, `id=${fresh}`))[0]).toMatchObject({ status: "sending", attempts: 1 });
  }));

  it("a stuck row that has used its 3 attempts is failed ('stuck'), not claimed again", () => withClient(async (c) => {
    const id = await mkRow(c, { status: "sending", attempts: 3, claimedAgo: "30 minutes" });
    expect(await claim(c)).toEqual([]);
    expect((await rows(c, `id=${id}`))[0]).toMatchObject({ status: "failed", last_error: "stuck", attempts: 3 });
  }));

  it("finish_outbox on an unknown id raises", () => withClient(async (c) => {
    await expect(finish(c, 999999, true, null)).rejects.toThrow(/unknown_outbox/);
  }));

  it("the status check accepts sending and still refuses unknown values and channels", () => withClient(async (c) => {
    await c.query("insert into notifications_outbox(channel,template,recipient,status) values ('email','t','a@b.test','sending')");
    await expect(c.query("insert into notifications_outbox(channel,template,recipient,status) values ('email','t','a@b.test','bogus')")).rejects.toThrow(/check constraint/);
    await expect(c.query("insert into notifications_outbox(channel,template,recipient) values ('fax','t','a@b.test')")).rejects.toThrow(/check constraint/);
  }));

  it("dedupe_key is unique where set; rows without a key are unrestricted", () => withClient(async (c) => {
    const ins = (k: string | null) => c.query("insert into notifications_outbox(channel,template,recipient,dedupe_key) values ('email','t','a@b.test',$1)", [k]);
    await ins(null); await ins(null); await ins("k1");
    await expect(ins("k1")).rejects.toThrow(/duplicate key|notifications_outbox_dedupe/);
  }));
});

// SKIP LOCKED needs two real, concurrent transactions. The usual harness is a single rolled-back transaction, so this one test uses three plain
// connections and COMMITS its three rows, then deletes them in `finally` (test files run one after the other, so nothing else sees them).
it("SKIP LOCKED: a claim made while another claim is still open skips the rows it holds (two overlapping cron runs never get the same row)", async () => {
  const url = process.env.DATABASE_URL_TEST;
  const [setup, a, b] = [new Client({ connectionString: url }), new Client({ connectionString: url }), new Client({ connectionString: url })];
  await Promise.all([setup.connect(), a.connect(), b.connect()]);
  let ids: number[] = [];
  try {
    ids = (await setup.query(
      `insert into notifications_outbox(channel,template,recipient,payload,send_after)
       select 'email','skip_locked_test','x@y.test','{}', now() - interval '1 hour' + n * interval '1 second' from generate_series(1,3) n returning id`)).rows.map((r) => Number(r.id));
    await a.query("begin");
    const first = (await a.query("select id from claim_outbox(2)")).rows.map((r) => Number(r.id)); // holds row locks until a commits
    expect(first).toEqual(ids.slice(0, 2));
    await b.query("begin");
    const second = (await b.query("select id from claim_outbox(25)")).rows.map((r) => Number(r.id));
    expect(second).toEqual(ids.slice(2)); // the two locked rows were skipped, not waited for
    await b.query("commit");
    await a.query("commit");
    const left = (await setup.query("select status, attempts from notifications_outbox where id = any($1)", [ids])).rows;
    expect(left).toEqual([{ status: "sending", attempts: 1 }, { status: "sending", attempts: 1 }, { status: "sending", attempts: 1 }]);
    expect((await setup.query("select id from claim_outbox(25)")).rowCount).toBe(0);
  } finally {
    await a.query("rollback").catch(() => {}); await b.query("rollback").catch(() => {});
    if (ids.length) await setup.query("delete from notifications_outbox where id = any($1)", [ids]);
    await Promise.all([setup.end(), a.end(), b.end()]);
  }
});

describe("enqueue_overdue_tasks", () => {
  const today = "(now() at time zone 'Africa/Johannesburg')::date";
  async function inv(c: Client, s: Seed, o: { status?: string; due?: string | null; total?: number } = {}) {
    const due = o.due === undefined ? -1 : o.due === null ? null : Number(o.due);
    return (await c.query(
      `insert into invoices(patient_id,total_cents,scheme_portion_cents,patient_portion_cents,payer_type,status,due_date)
       values ($1,$2::int,0,$2::int,'self',$3, case when $4::int is null then null else ${today} + $4::int end) returning id`,
      [s.p, o.total ?? 100000, o.status ?? "issued", due])).rows[0].id as string;
  }
  const run = async (c: Client) => (await asService(c, () => c.query("select enqueue_overdue_tasks() as n"))).rows[0].n as number;
  const tasks = async (c: Client) => (await c.query("select * from tasks where source like 'overdue_invoice:%' order by source")).rows;

  it("creates ONE task per overdue invoice, once: a repeat run (and a done task) creates nothing more", () => withClient(async (c) => {
    const s = await seed(c);
    const a = await inv(c, s, { due: "-1" }), b = await inv(c, s, { status: "part_paid", due: "-30" });
    expect(await run(c)).toBe(2);
    expect(await run(c)).toBe(0);
    const t = await tasks(c);
    expect(t.map((r) => r.source).sort()).toEqual([`overdue_invoice:${a}`, `overdue_invoice:${b}`].sort());
    expect(t[0]).toMatchObject({ title: "Overdue invoice: follow up", priority: "normal", status: "open", patient_id: s.p });
    expect(t.find((r) => r.source === `overdue_invoice:${a}`).meta).toEqual({ invoice_id: a });
    await c.query("update tasks set status='done' where source like 'overdue_invoice:%'");
    expect(await run(c)).toBe(0); // done is done: it is not reopened or duplicated
    expect((await tasks(c)).length).toBe(2);
  }));

  it("ignores invoices that are not overdue or owe nothing", () => withClient(async (c) => {
    const s = await seed(c);
    await inv(c, s, { due: "0" });                      // due today (SAST): not yet overdue
    await inv(c, s, { due: "5" });                      // due in the future
    await inv(c, s, { status: "draft", due: "-10" });
    await inv(c, s, { status: "void", due: "-10" });
    await inv(c, s, { status: "paid", due: "-10" });
    const credited = await inv(c, s, { due: "-10", total: 5000 });
    await c.query("insert into payments(invoice_id,method,amount_cents,status) values ($1,'cash',5000,'succeeded')", [credited]); // fully paid: outstanding 0
    expect(await run(c)).toBe(0);
    expect((await tasks(c)).length).toBe(0);
  }));

  it("the title carries no patient name, and psychologist and admin see the task; patients do not", () => withClient(async (c) => {
    const s = await seed(c);
    await c.query("update patients set first_name='Thandiwe', last_name='Nkosi' where id=$1", [s.p]);
    await inv(c, s);
    await run(c);
    const t = (await tasks(c))[0];
    expect(t.title).not.toMatch(/Thandiwe|Nkosi/);
    const visible = (u: string) => asUser(c, u, async () => (await c.query("select 1 from tasks where source like 'overdue_invoice:%'")).rowCount);
    expect(await visible(s.psy)).toBe(1);
    expect(await visible(s.adm)).toBe(1);
    expect(await visible(s.pat)).toBe(0);
  }));
});

describe("grants", () => {
  const FNS = ["claim_outbox(int)", "finish_outbox(bigint,boolean,text)", "enqueue_reminders()", "enqueue_overdue_tasks()", "sast_short_date(timestamptz)"];
  const CALLS: [string, unknown[]][] = [
    ["select * from claim_outbox(1)", []], ["select finish_outbox(1,true,null)", []], ["select enqueue_reminders()", []], ["select enqueue_overdue_tasks()", []],
    ["select sast_short_date(now())", []],
  ];

  it("service_role may execute every function; anon, authenticated and public may not", () => withClient(async (c) => {
    for (const f of FNS) {
      const r = (await c.query(
        "select has_function_privilege('service_role', $1, 'execute') s, has_function_privilege('authenticated', $1, 'execute') a, has_function_privilege('anon', $1, 'execute') n", [f])).rows[0];
      expect(r, f).toEqual({ s: true, a: false, n: false });
    }
    const pub = await c.query("select 1 from pg_proc p where p.proname = any($1) and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)",
      [["claim_outbox", "finish_outbox", "enqueue_reminders", "enqueue_overdue_tasks", "sast_short_date"]]);
    expect(pub.rowCount).toBe(0);
  }));

  it("calling them as a signed-in user or as anon fails with permission denied; as service_role it works", () => withClient(async (c) => {
    const u = await mkUser(c, "psychologist"); // even staff cannot run the worker
    for (const [sql, params] of CALLS) {
      await expect(asUser(c, u, () => c.query(sql, params)), sql).rejects.toThrow(/permission denied for function/);
      await c.query("set local role anon");
      try { await expect(c.query(sql, params), `anon ${sql}`).rejects.toThrow(/permission denied for function/); } finally { await c.query("reset role"); }
    }
    expect(await enqueue(c)).toBe(0);
    expect((await claim(c)).length).toBe(0);
  }));

  it("the outbox table stays service-role only", () => withClient(async (c) => {
    const u = await mkUser(c, "psychologist");
    expect((await c.query("select relrowsecurity from pg_class where relname='notifications_outbox'")).rows[0].relrowsecurity).toBe(true);
    for (const cols of ["dedupe_key", "last_error", "sent_at", "claimed_at", "status"]) {
      await expect(asUser(c, u, () => c.query(`select ${cols} from notifications_outbox`)), cols).rejects.toThrow(/permission denied for table notifications_outbox/);
    }
    for (const role of ["anon", "authenticated"]) {
      const r = (await c.query("select has_table_privilege($1,'notifications_outbox','select,insert,update,delete') any_priv", [role])).rows[0];
      expect(r.any_priv, role).toBe(false);
    }
    expect((await c.query("select has_table_privilege('service_role','notifications_outbox','select') s")).rows[0].s).toBe(true);
  }));
});
