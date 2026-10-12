// Cross-table isolation suite (Task 7). One shared "world" with two patients (A and B), a guardian each, every staff role and at
// least one row in every patient-owned table; then we read, write and call functions as the wrong person and assert exactly
// what happens. Nothing here is mocked: it exercises the real policies, grants and guard triggers from migrations 0001-0005.
import { describe, it, expect } from "vitest";
import type { Client } from "pg";
import { withClient, asUser, mkUser } from "./helpers";
import { seed, guardianWith, pay, as } from "./billing-helpers";

const DEFAULT_PERMS = '{"book":true,"forms":true,"pay":true}';
const FUTURE = (hour: string) => `2031-01-07T${hour}:00:00Z`; // far future (a Tuesday); superuser setup is exempt from availability rules

/** run a statement and report either its rowCount or the exact error message */
async function attempt(p: Promise<{ rowCount: number | null }>): Promise<number | string> {
  try { return (await p).rowCount ?? -1; } catch (e) { return (e as Error).message; }
}
const asAnon = async <T>(c: Client, fn: () => Promise<T>) => {
  await c.query("set local role anon");
  try { return await fn(); } finally { await c.query("reset role"); }
};
// 0018: credit_notes grants `authenticated` only these columns (reason / created_by are served by credit_note_details to staff), so `select *` is
// "permission denied" for every signed-in user; the sweep reads the granted columns, which is all row visibility needs.
const COLUMNS: Record<string, string> = { credit_notes: "id, invoice_id, amount_cents, portion, created_at" };
const rows = async (c: Client, u: string, table: string) => (await as(c, u, `select ${COLUMNS[table] ?? "*"} from ${table}`)).rows;
const publicTables = async (c: Client, kinds = ["r"]) => (await c.query(
  "select c.relname n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = any($1) order by 1", [kinds])).rows.map((r) => r.n as string);

/** everything a test needs: ids for A (patient 1) and B (patient 2), staff, guardians, and the seeded rows of each patient */
async function world(c: Client) {
  const s = await seed(c); // psy adm bk assoc u1 u2 p1 p2 g (current guardian of p1) gOld (expired guardian of p1)
  const gB = await guardianWith(c, s.p2, DEFAULT_PERMS);
  const st = (await c.query("insert into session_types(name,duration_min,fee_cents) values ('t',50,1000) returning id")).rows[0].id as string;
  const ft = (await c.query("insert into form_templates(key,version,schema) values ('k',1,'{}') returning id")).rows[0].id as string;
  await c.query("insert into availability_rules(weekday,start_time,end_time) values (2,'09:00','17:00')");
  await c.query("insert into blocked_times(starts_at,ends_at,reason) values ('2031-02-01T08:00Z','2031-02-01T09:00Z','x')");
  await c.query("insert into notifications_outbox(channel,template,recipient) values ('email','t','a@b.test')");
  await c.query("insert into retention_policies(record_type,retain_years) values ('notes',10)");
  const mk = async (p: string, hour: string, tag: string) => {
    const appt = (await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,$3,$4) returning id",
      [p, st, FUTURE(hour), FUTURE(String(Number(hour) + 1).padStart(2, "0"))])).rows[0].id as string;
    const sub = (await c.query("insert into form_submissions(patient_id,template_id,template_version,status) values ($1,$2,1,'submitted') returning id", [p, ft])).rows[0].id as string;
    const draft = (await c.query("insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1) returning id", [p, ft])).rows[0].id as string;
    await c.query("select set_consent($1,'treatment',true,$2)", [p, sub]);
    const member = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'Discovery','123') returning id", [p])).rows[0].id as string;
    // invoice: lines can only be added to a draft, so build it as a draft and issue it (patients never see drafts)
    const inv = (await c.query("insert into invoices(patient_id,subtotal_cents,total_cents,scheme_portion_cents,patient_portion_cents,payer_type) values ($1,100000,100000,80000,20000,'medical_aid') returning id", [p])).rows[0].id as string;
    const line = (await c.query("insert into invoice_lines(invoice_id,description,quantity,unit_cents) values ($1,'Session',1,100000) returning id", [inv])).rows[0].id as string;
    await c.query("update invoices set status='issued' where id=$1", [inv]);
    const payment = (await pay(c, s.psy, inv, "eft", 5000)).rows[0].id as string;
    const credit = (await as(c, s.psy, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,1000,'goodwill','patient') returning id", [inv])).rows[0].id as string;
    const claim = (await as(c, s.psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,80000,'{F41.1}') returning id", [inv, member])).rows[0].id as string;
    await as(c, s.psy, "update claims set status='submitted' where id=$1", [claim]);
    await as(c, s.psy, "select record_scheme_remittance($1,1000,$2)", [claim, `REM-${tag}`]); // payment #2 + claim_payments + claim_events
    const note = (await as(c, s.psy, "insert into clinical_notes(patient_id,author_id,content) values ($1,$2,'{\"notes\":\"a\"}') returning id", [p, s.psy])).rows[0].id as string;
    await as(c, s.psy, "update clinical_notes set content='{\"notes\":\"b\"}' where id=$1", [note]); // -> note_versions row
    await as(c, s.psy, "select sign_note($1)", [note]);
    await as(c, s.psy, "select add_addendum($1,'later')", [note]); // -> note_addenda row, note becomes amended
    await c.query("insert into tasks(title,patient_id) values ('t',$1)", [p]);
    return { appt, sub, draft, member, inv, line, payment, credit, claim, note };
  };
  const a = await mk(s.p1, "08", "A"), b = await mk(s.p2, "10", "B");
  const gAbook = await guardianWith(c, s.p1, '{"book":false,"forms":true,"pay":true}');
  return { ...s, gB, st, ft, a, b, gAbook };
}
type W = Awaited<ReturnType<typeof world>>;

// ---- 1. READ isolation ---------------------------------------------------------------------------------------------------
// Expected row counts for [patient themself, current guardian with full permissions]. Each actor owns exactly ONE patient
// (patient A / guardian of A; patient B / guardian of B); both patients have identical data, so a count that is too high means
// the other patient's rows leaked. 0 means "no policy for patients". "denied" means the API roles have no privilege at all.
type Exp = number | "denied";
const READ: [string, Exp, Exp][] = [
  // patient-owned data: exactly this patient's rows
  ["patients", 1, 1], ["appointments", 1, 1], ["appointment_events", 1, 1],
  ["form_submissions", 2, 2], // one submitted + one draft
  ["form_submission_versions", 1, 1], ["consents", 1, 1],
  ["invoices", 1, 1], ["invoice_lines", 1, 1], ["credit_notes", 1, 1],
  ["payments", 2, 2], // the manual EFT payment and the scheme remittance
  ["medical_aid_members", 1, 1],
  // a patient is not anyone's guardian, so sees no guardianship rows; the guardian sees only their own link
  ["guardianships", 0, 1],
  // staff-only tables: nothing for patients or guardians although both patients have rows in them
  ["tasks", 0, 0], ["clinical_notes", 0, 0], ["note_versions", 0, 0], ["note_addenda", 0, 0],
  ["claims", 0, 0], ["claim_events", 0, 0], ["claim_payments", 0, 0], ["claim_summary", 0, 0],
  ["audit_log", 0, 0], ["retention_policies", 0, 0], ["icd10_codes", 0, 0], ["blocked_times", 0, 0], ["note_templates", 0, 0],
  ["notifications_outbox", "denied", "denied"], // service role only: authenticated has no privilege at all
  // reference / own-identity data that every signed-in user may read
  ["profiles", 1, 1], // own profile only
  ["practices", 1, 1], ["session_types", 1, 1], ["availability_rules", 1, 1], ["form_templates", 1, 1],
];
const PATIENT_COL: Record<string, string> = { patients: "id", appointments: "patient_id", form_submissions: "patient_id", consents: "patient_id",
  invoices: "patient_id", medical_aid_members: "patient_id", guardianships: "patient_id" };

it("the read matrix covers every table in schema public", () => withClient(async (c) => {
  const have = [...(await publicTables(c)), "claim_summary"].sort();
  expect(READ.map((r) => r[0]).sort()).toEqual(have);
}));

it.each(READ)("patient A / B and their guardians read only their own rows of %s", (table, patientN, guardianN) => withClient(async (c) => {
  const w = await world(c);
  const actors: [string, string, Exp, string][] = [ // [label, user, expected, the patient that actor owns]
    ["patient A", w.u1, patientN, w.p1], ["patient B", w.u2, patientN, w.p2],
    ["guardian of A", w.g, guardianN, w.p1], ["guardian of B", w.gB, guardianN, w.p2]];
  for (const [who, u, n, own] of actors) {
    if (n === "denied") { expect(await attempt(as(c, u, `select * from ${table}`)), `${who} ${table}`).toBe(`permission denied for table ${table}`); continue; }
    const r = await rows(c, u, table);
    expect(r.length, `${who} ${table}`).toBe(n);
    const col = PATIENT_COL[table];
    if (col && r.length) expect([...new Set(r.map((x) => x[col]))], `${who} ${table} owner`).toEqual([own]);
  }
}));

// ---- 2. WRITE isolation ----------------------------------------------------------------------------------------------------
// Patient A attacks. A number is the exact rowCount (RLS silently filters the row); a string is the exact error message.
const RLS = (t: string) => `new row violates row-level security policy for table "${t}"`;
const NOPRIV = (t: string) => `permission denied for table ${t}`;
type Atk = [string, (w: W) => [string, unknown[]], number | string];
const ATTACKS: Atk[] = [
  // patients
  ["update B's patient row", (w) => ["update patients set phone='999' where id=$1", [w.p2]], 0],
  ["update every patient but own", (w) => ["update patients set phone='999' where id<>$1", [w.p1]], 0],
  ["take over B's patient row", (w) => ["update patients set user_id=$1 where id=$2", [w.u1, w.p2]], 0],
  ["delete B's patient row", (w) => ["delete from patients where id=$1", [w.p2]], 0],
  ["delete own patient row", (w) => ["delete from patients where id=$1", [w.p1]], 0],
  ["insert a patient", () => ["insert into patients(first_name,last_name) values ('X','X')", []], RLS("patients")],
  // identity and practice settings
  ["promote own profile to psychologist", (w) => ["update profiles set role='psychologist' where user_id=$1", [w.u1]], 0],
  ["rewrite B's profile", (w) => ["update profiles set display_name='x' where user_id=$1", [w.u2]], 0],
  ["delete own profile", (w) => ["delete from profiles where user_id=$1", [w.u1]], 0],
  ["insert a profile", () => ["insert into profiles(user_id,role,display_name) values (gen_random_uuid(),'psychologist','x')", []], RLS("profiles")],
  ["update practice settings", () => ["update practices set approval_mode='auto'", []], 0],
  // appointments
  ["update B's appointment", (w) => ["update appointments set status='cancelled' where id=$1", [w.b.appt]], 0],
  ["update own appointment directly", (w) => ["update appointments set status='cancelled' where id=$1", [w.a.appt]], 0],
  ["delete B's appointment", (w) => ["delete from appointments where id=$1", [w.b.appt]], 0],
  ["delete own appointment", (w) => ["delete from appointments where id=$1", [w.a.appt]], 0],
  ["insert an appointment for B", (w) => ["insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,$3,$4)", [w.p2, w.st, FUTURE("12"), FUTURE("13")]], RLS("appointments")],
  ["insert an appointment for self", (w) => ["insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,$3,$4)", [w.p1, w.st, FUTURE("12"), FUTURE("13")]], RLS("appointments")],
  ["update B's appointment event", (w) => ["update appointment_events set event='x' where appointment_id=$1", [w.b.appt]], 0],
  ["delete own appointment event", (w) => ["delete from appointment_events where appointment_id=$1", [w.a.appt]], 0],
  ["insert an appointment event", (w) => ["insert into appointment_events(appointment_id,event) values ($1,'x')", [w.a.appt]], RLS("appointment_events")],
  // reference data: patients must not be able to change fees, hours, templates or the blocked calendar
  ["change a session fee", () => ["update session_types set fee_cents=1", []], 0],
  ["insert a session type", () => ["insert into session_types(name,duration_min,fee_cents) values ('x',50,0)", []], RLS("session_types")],
  ["delete availability", () => ["delete from availability_rules", []], 0],
  ["insert availability", () => ["insert into availability_rules(weekday,start_time,end_time) values (1,'00:00','23:00')", []], RLS("availability_rules")],
  ["update blocked time", () => ["update blocked_times set reason='x'", []], 0],
  ["insert a blocked time", () => ["insert into blocked_times(starts_at,ends_at) values ('2031-03-01T08:00Z','2031-03-01T09:00Z')", []], RLS("blocked_times")],
  ["edit a form template", () => ["update form_templates set schema='{\"x\":1}'", []], 0],
  ["insert a form template", () => ["insert into form_templates(key,version,schema) values ('z',1,'{}')", []], RLS("form_templates")],
  ["edit a note template", () => ["update note_templates set name='x'", []], 0],
  // form submissions: B's draft is writable by B, so the only thing stopping A is the policy
  ["update B's draft submission", (w) => ["update form_submissions set answers='{\"x\":1}' where id=$1", [w.b.draft]], 0],
  ["submit B's draft submission", (w) => ["update form_submissions set status='submitted' where id=$1", [w.b.draft]], 0],
  ["update B's submitted submission", (w) => ["update form_submissions set answers='{\"x\":1}' where id=$1", [w.b.sub]], 0],
  ["update own submitted submission", (w) => ["update form_submissions set answers='{\"x\":1}' where id=$1", [w.a.sub]], 0],
  ["move A's draft onto B", (w) => ["update form_submissions set patient_id=$2 where id=$1", [w.a.draft, w.p2]], "protected submission columns cannot be changed"],
  ["delete B's submission", (w) => ["delete from form_submissions where id=$1", [w.b.draft]], NOPRIV("form_submissions")],
  ["insert a draft submission for B", (w) => ["insert into form_submissions(patient_id,template_id,template_version) values ($1,$2,1)", [w.p2, w.ft]], RLS("form_submissions")],
  ["insert a submission version", (w) => ["insert into form_submission_versions(submission_id,event,answers,template_version) values ($1,'submitted','{}',1)", [w.a.sub]], NOPRIV("form_submission_versions")],
  ["update B's submission version", (w) => ["update form_submission_versions set answers='{}' where submission_id=$1", [w.b.sub]], NOPRIV("form_submission_versions")],
  ["delete a submission version", (w) => ["delete from form_submission_versions where submission_id=$1", [w.a.sub]], NOPRIV("form_submission_versions")],
  // consents (written only by set_consent)
  ["insert a consent for B", (w) => ["insert into consents(patient_id,purpose,granted) values ($1,'telehealth',true)", [w.p2]], NOPRIV("consents")],
  ["update B's consent", (w) => ["update consents set granted=false where patient_id=$1", [w.p2]], NOPRIV("consents")],
  ["update own consent directly", (w) => ["update consents set granted=false where patient_id=$1", [w.p1]], NOPRIV("consents")],
  ["delete B's consent", (w) => ["delete from consents where patient_id=$1", [w.p2]], NOPRIV("consents")],
  // billing
  ["update B's invoice", (w) => ["update invoices set status='void' where id=$1", [w.b.inv]], 0],
  ["update own invoice", (w) => ["update invoices set total_cents=1, scheme_portion_cents=0, patient_portion_cents=1 where id=$1", [w.a.inv]], 0],
  ["delete B's invoice", (w) => ["delete from invoices where id=$1", [w.b.inv]], NOPRIV("invoices")],
  ["insert an invoice for B", (w) => ["insert into invoices(patient_id) values ($1)", [w.p2]], RLS("invoices")],
  ["insert an invoice for self", (w) => ["insert into invoices(patient_id) values ($1)", [w.p1]], RLS("invoices")],
  ["update B's invoice line", (w) => ["update invoice_lines set unit_cents=1 where id=$1", [w.b.line]], 0],
  ["delete B's invoice line", (w) => ["delete from invoice_lines where id=$1", [w.b.line]], 0],
  ["insert a line on B's invoice", (w) => ["insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'x',1)", [w.b.inv]], "forbidden"],
  ["insert a line on own invoice", (w) => ["insert into invoice_lines(invoice_id,description,unit_cents) values ($1,'x',1)", [w.a.inv]], "forbidden"],
  ["insert a payment on B's invoice", (w) => ["insert into payments(invoice_id,method,amount_cents,reference) values ($1,'cash',100,null)", [w.b.inv]], NOPRIV("payments")],
  ["insert a payment on own invoice", (w) => ["insert into payments(invoice_id,method,amount_cents,reference) values ($1,'cash',100,null)", [w.a.inv]], NOPRIV("payments")],
  ["update B's payment", (w) => ["update payments set amount_cents=1 where id=$1", [w.b.payment]], NOPRIV("payments")],
  ["delete own payment", (w) => ["delete from payments where id=$1", [w.a.payment]], NOPRIV("payments")],
  ["credit B's invoice", (w) => ["insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,100,'x','patient')", [w.b.inv]], "forbidden"],
  ["credit own invoice", (w) => ["insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,100,'x','patient')", [w.a.inv]], "forbidden"],
  ["update B's credit note", (w) => ["update credit_notes set amount_cents=1 where id=$1", [w.b.credit]], NOPRIV("credit_notes")],
  ["delete own credit note", (w) => ["delete from credit_notes where id=$1", [w.a.credit]], NOPRIV("credit_notes")],
  // medical aid and claims
  ["update B's medical aid member", (w) => ["update medical_aid_members set member_number='1' where id=$1", [w.b.member]], 0],
  ["update own medical aid member", (w) => ["update medical_aid_members set member_number='1' where id=$1", [w.a.member]], 0],
  ["delete B's medical aid member", (w) => ["delete from medical_aid_members where id=$1", [w.b.member]], NOPRIV("medical_aid_members")],
  ["insert a medical aid member for B", (w) => ["insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'S','1')", [w.p2]], RLS("medical_aid_members")],
  ["insert a medical aid member for self", (w) => ["insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'S','1')", [w.p1]], RLS("medical_aid_members")],
  ["update B's claim", (w) => ["update claims set status='rejected' where id=$1", [w.b.claim]], 0],
  ["delete B's claim", (w) => ["delete from claims where id=$1", [w.b.claim]], NOPRIV("claims")],
  ["insert a claim", (w) => ["insert into claims(invoice_id,member_id,claimed_cents) values ($1,$2,1)", [w.a.inv, w.a.member]], "forbidden"],
  ["insert a claim event", (w) => ["insert into claim_events(claim_id,event) values ($1,'x')", [w.a.claim]], NOPRIV("claim_events")],
  ["insert a claim payment", (w) => ["insert into claim_payments(claim_id,payment_id,amount_cents) values ($1,$2,1)", [w.a.claim, w.a.payment]], NOPRIV("claim_payments")],
  ["insert an ICD-10 code", () => ["insert into icd10_codes values ('X99','x')", []], NOPRIV("icd10_codes")],
  ["write through the claim summary view", (w) => ["update claim_summary set claimed_cents=1 where id=$1", [w.a.claim]], "permission denied for view claim_summary"],
  // guardianships (no API role can write them, patients least of all)
  ["make self a guardian of B", (w) => ["insert into guardianships(guardian_user_id,patient_id) values ($1,$2)", [w.u1, w.p2]], RLS("guardianships")],
  ["update B's guardianship", (w) => ["update guardianships set permissions='{}' where patient_id=$1", [w.p2]], 0],
  ["delete B's guardianship", (w) => ["delete from guardianships where patient_id=$1", [w.p2]], 0],
  // clinical notes
  ["insert a clinical note", (w) => ["insert into clinical_notes(patient_id,author_id) values ($1,$2)", [w.p1, w.u1]], RLS("clinical_notes")],
  ["update B's clinical note", (w) => ["update clinical_notes set risk='{}' where id=$1", [w.b.note]], 0],
  ["delete a clinical note", (w) => ["delete from clinical_notes where id=$1", [w.a.note]], 0],
  ["insert a note version", (w) => ["insert into note_versions(note_id,version_no,content) values ($1,9,'{}')", [w.a.note]], NOPRIV("note_versions")],
  ["insert a note addendum", (w) => ["insert into note_addenda(note_id,content,author_id) values ($1,'x',$2)", [w.a.note, w.u1]], RLS("note_addenda")],
  ["update a note addendum", () => ["update note_addenda set content='x'", []], NOPRIV("note_addenda")],
  // operations tables
  ["insert a task", () => ["insert into tasks(title) values ('x')", []], RLS("tasks")],
  ["update B's task", (w) => ["update tasks set status='done' where patient_id=$1", [w.p2]], 0],
  ["delete a task", () => ["delete from tasks", []], 0],
  ["insert into the outbox", () => ["insert into notifications_outbox(channel,template,recipient) values ('email','t','x@y.test')", []], NOPRIV("notifications_outbox")],
  ["update the outbox", () => ["update notifications_outbox set status='sent'", []], NOPRIV("notifications_outbox")],
  ["delete from the outbox", () => ["delete from notifications_outbox", []], NOPRIV("notifications_outbox")],
  ["update retention policy", () => ["update retention_policies set retain_years=0", []], 0],
  ["insert a retention policy", () => ["insert into retention_policies(record_type,retain_years) values ('x',1)", []], RLS("retention_policies")],
  ["forge an audit row", (w) => ["insert into audit_log(actor_id,action) values ($1,'forged')", [w.u1]], NOPRIV("audit_log")],
  ["rewrite the audit log", () => ["update audit_log set action='x'", []], NOPRIV("audit_log")],
  ["delete from the audit log", () => ["delete from audit_log", []], NOPRIV("audit_log")],
];

/** content hash + row count of every ordinary public table, read as the superuser */
const snapshot = async (c: Client) => {
  const out: Record<string, string> = {};
  for (const t of await publicTables(c)) {
    const r = (await c.query(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h, count(*) n from public."${t}" x`)).rows[0];
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
};

describe("patient A cannot write patient B's data (or anything staff-only)", () => {
  it.each(ATTACKS)("%s", (_label, build, expected) => withClient(async (c) => {
    const w = await world(c);
    const [sql, params] = build(w);
    const before = await snapshot(c);
    expect(await attempt(asUser(c, w.u1, () => c.query(sql, params)))).toBe(expected);
    expect(await snapshot(c), "no table changed").toEqual(before);
  }));

  // controls: the same harness does let A change what the spec allows, so the zeros above are policy, not a broken test
  it("control: A can edit own contact details and own draft submission", () => withClient(async (c) => {
    const w = await world(c);
    expect(await attempt(asUser(c, w.u1, () => c.query("update patients set phone='082' where id=$1", [w.p1])))).toBe(1);
    expect(await attempt(asUser(c, w.u1, () => c.query("update form_submissions set answers='{\"x\":1}' where id=$1", [w.a.draft])))).toBe(1);
    expect((await c.query("select phone from patients where id=$1", [w.p1])).rows[0].phone).toBe("082");
    expect((await c.query("select phone from patients where id=$1", [w.p2])).rows[0].phone).toBeNull();
    // ...but not the protected columns, even on the own row
    expect(await attempt(asUser(c, w.u1, () => c.query("update patients set status='archived' where id=$1", [w.p1])))).toBe("protected patient columns can only be changed by staff");
  }));
});

// ---- 3. FUNCTION isolation -------------------------------------------------------------------------------------------------
describe("security definer functions refuse the wrong caller", () => {
  const call = (c: Client, u: string, sql: string, params: unknown[]) => attempt(asUser(c, u, () => c.query(sql, params)));
  it("patient A cannot book, cancel, reschedule or set consent for B", () => withClient(async (c) => {
    const w = await world(c);
    const before = await snapshot(c);
    expect(await call(c, w.u1, "select book_appointment($1,$2,$3)", [w.p2, w.st, FUTURE("14")])).toBe("forbidden");
    expect(await call(c, w.u1, "select cancel_appointment($1,'x')", [w.b.appt])).toBe("forbidden");
    expect(await call(c, w.u1, "select reschedule_appointment($1,$2)", [w.b.appt, FUTURE("15")])).toBe("forbidden");
    expect(await call(c, w.u1, "select set_consent($1,'telehealth',true,null)", [w.p2])).toBe("forbidden");
    expect(await call(c, w.u1, "select set_consent($1,'treatment',false,null)", [w.p2])).toBe("forbidden"); // withdrawing B's consent too
    // A's own patient, but a submission that belongs to B
    expect(await call(c, w.u1, "select set_consent($1,'telehealth',true,$2)", [w.p1, w.b.sub])).toBe("submission_mismatch");
    expect(await snapshot(c), "no table changed").toEqual(before);
  }));
  it("B's guardian-of-A counterpart: guardian of A cannot act for B either", () => withClient(async (c) => {
    const w = await world(c);
    const before = await snapshot(c);
    expect(await call(c, w.g, "select book_appointment($1,$2,$3)", [w.p2, w.st, FUTURE("14")])).toBe("forbidden");
    expect(await call(c, w.g, "select cancel_appointment($1,'x')", [w.b.appt])).toBe("forbidden");
    expect(await call(c, w.g, "select reschedule_appointment($1,$2)", [w.b.appt, FUTURE("15")])).toBe("forbidden");
    expect(await call(c, w.g, "select set_consent($1,'telehealth',true,null)", [w.p2])).toBe("forbidden");
    expect(await snapshot(c)).toEqual(before);
  }));
  it("only psychologist or admin can record payments or remittances: patient, guardian, bookkeeper, associate get exactly 'forbidden'", () => withClient(async (c) => {
    const w = await world(c);
    const before = await snapshot(c);
    for (const [who, u] of [["patient A", w.u1], ["patient B", w.u2], ["guardian", w.g], ["bookkeeper", w.bk], ["associate", w.assoc]] as const) {
      expect(await call(c, u, "select record_payment($1,'cash',100,null,null)", [w.a.inv]), `${who} record_payment own invoice`).toBe("forbidden");
      expect(await call(c, u, "select record_payment($1,'cash',100,null,null)", [w.b.inv]), `${who} record_payment other invoice`).toBe("forbidden");
      expect(await call(c, u, "select record_payment($1,'payfast',100,'PF-1',null)", [w.a.inv]), `${who} payfast`).toBe("forbidden");
      expect(await call(c, u, "select record_scheme_remittance($1,100,'R-1')", [w.a.claim]), `${who} remittance`).toBe("forbidden");
    }
    expect(await snapshot(c)).toEqual(before);
  }));
});

// ---- 4. GUARDIANS -----------------------------------------------------------------------------------------------------------
describe("guardians", () => {
  it("a guardian of kid1 sees only kid1's patients, appointments, invoices and forms, and none of kid2's", () => withClient(async (c) => {
    const w = await world(c); // g guards p1 (kid1) only; p2 (kid2) belongs to someone else
    const ids = async (table: string, col: string) => [...new Set((await rows(c, w.g, table)).map((r) => r[col] as string))];
    expect(await ids("patients", "id")).toEqual([w.p1]);
    expect(await ids("appointments", "patient_id")).toEqual([w.p1]);
    expect(await ids("invoices", "patient_id")).toEqual([w.p1]);
    expect(await ids("form_submissions", "patient_id")).toEqual([w.p1]);
    expect((await rows(c, w.g, "appointments")).map((r) => r.id)).toEqual([w.a.appt]);
    expect((await rows(c, w.g, "invoices")).map((r) => r.id)).toEqual([w.a.inv]);
    expect((await rows(c, w.g, "form_submissions")).map((r) => r.id).sort()).toEqual([w.a.sub, w.a.draft].sort());
    // and a direct lookup of kid2's rows by id returns nothing
    for (const [t, id] of [["patients", w.p2], ["appointments", w.b.appt], ["invoices", w.b.inv], ["form_submissions", w.b.sub], ["payments", w.b.payment]] as const)
      expect((await as(c, w.g, `select 1 from ${t} where id=$1`, [id])).rowCount, t).toBe(0);
  }));

  it("a guardian guarding two kids sees both and nothing of a third patient", () => withClient(async (c) => {
    const w = await world(c);
    await c.query("insert into guardianships(guardian_user_id,patient_id) values ($1,$2)", [w.g, w.p2]);
    expect((await rows(c, w.g, "patients")).map((r) => r.id).sort()).toEqual([w.p1, w.p2].sort());
    const p3 = (await c.query("insert into patients(first_name,last_name) values ('C','C') returning id")).rows[0].id as string;
    await c.query("insert into appointments(patient_id,session_type_id,starts_at,ends_at) values ($1,$2,$3,$4)", [p3, w.st, FUTURE("16"), FUTURE("17")]);
    expect((await rows(c, w.g, "appointments")).length).toBe(2);
  }));

  it("pay=false: no invoices or payments, but appointments (book=true) and forms (forms=true) remain visible", () => withClient(async (c) => {
    const w = await world(c);
    const gNoPay = await guardianWith(c, w.p1, '{"book":true,"forms":true,"pay":false}');
    for (const t of ["invoices", "invoice_lines", "credit_notes", "payments", "medical_aid_members"]) expect((await rows(c, gNoPay, t)).length, t).toBe(0);
    expect((await rows(c, gNoPay, "appointments")).length).toBe(1);
    expect((await rows(c, gNoPay, "appointment_events")).length).toBe(1);
    expect((await rows(c, gNoPay, "form_submissions")).length).toBe(2);
    expect((await rows(c, gNoPay, "consents")).length).toBe(1);
    expect((await rows(c, gNoPay, "patients")).length).toBe(1);
    // the control guardian (pay=true) still sees the billing rows
    expect((await rows(c, w.g, "invoices")).length).toBe(1);
  }));

  it("forms=false: no submissions, versions or consents, but invoices and appointments remain visible; and they cannot set consent", () => withClient(async (c) => {
    const w = await world(c);
    const gNoForms = await guardianWith(c, w.p1, '{"book":true,"forms":false,"pay":true}');
    for (const t of ["form_submissions", "form_submission_versions", "consents"]) expect((await rows(c, gNoForms, t)).length, t).toBe(0);
    expect((await rows(c, gNoForms, "invoices")).length).toBe(1);
    expect((await rows(c, gNoForms, "appointments")).length).toBe(1);
    expect(await attempt(as(c, gNoForms, "select set_consent($1,'telehealth',true,null)", [w.p1]))).toBe("forbidden");
  }));

  it("book=false: still sees appointments but cannot book, cancel or reschedule", () => withClient(async (c) => {
    const w = await world(c);
    expect((await rows(c, w.gAbook, "appointments")).length).toBe(1);
    expect(await attempt(as(c, w.gAbook, "select book_appointment($1,$2,$3)", [w.p1, w.st, FUTURE("14")]))).toBe("forbidden");
    expect(await attempt(as(c, w.gAbook, "select cancel_appointment($1,'x')", [w.a.appt]))).toBe("forbidden");
    expect(await attempt(as(c, w.gAbook, "select reschedule_appointment($1,$2)", [w.a.appt, FUTURE("15")]))).toBe("forbidden");
    expect((await c.query("select status from appointments where id=$1", [w.a.appt])).rows[0].status).toBe("confirmed");
  }));

  it.each([
    ["expired (valid_to in the past)", "2000-01-01", null],
    ["not yet valid (valid_from in the future)", null, "2999-01-01"],
  ])("a guardianship that is %s sees nothing and can do nothing", (_label, validTo, validFrom) => withClient(async (c) => {
    const w = await world(c);
    const gx = await mkUser(c, "guardian");
    await c.query("insert into guardianships(guardian_user_id,patient_id,valid_to,valid_from) values ($1,$2,$3,coalesce($4::date,current_date))", [gx, w.p1, validTo, validFrom]);
    for (const [t] of READ) {
      if (["guardianships", "profiles", "practices", "session_types", "availability_rules", "form_templates", "notifications_outbox"].includes(t)) continue;
      expect((await rows(c, gx, t)).length, t).toBe(0); // patient-owned and staff-only tables alike
    }
    expect((await rows(c, gx, "guardianships")).length).toBe(1); // the link itself is still the guardian's own row
    expect(await attempt(as(c, gx, "select book_appointment($1,$2,$3)", [w.p1, w.st, FUTURE("14")]))).toBe("forbidden");
    expect(await attempt(as(c, gx, "select cancel_appointment($1,'x')", [w.a.appt]))).toBe("forbidden");
    expect(await attempt(as(c, gx, "select set_consent($1,'telehealth',true,null)", [w.p1]))).toBe("forbidden");
  }));
});

// ---- 5. ANON sweep ----------------------------------------------------------------------------------------------------------
// Tables that migrations intentionally expose to the unauthenticated public role (policy has no TO clause):
const ANON_READABLE: Record<string, string> = {
  session_types: "public booking page lists bookable services, durations and fees",
  availability_rules: "public booking page computes free slots from the practice's working hours",
};
describe("anon", () => {
  it("only the documented tables have a policy that applies to anon/public", () => withClient(async (c) => {
    const r = await c.query("select distinct tablename from pg_policies where schemaname='public' and (roles && array['public','anon']::name[]) order by 1");
    expect(r.rows.map((x) => x.tablename)).toEqual(Object.keys(ANON_READABLE).sort());
  }));

  it("sees 0 rows of, or is denied on, every other table and view; the allow-listed tables are read-only", () => withClient(async (c) => {
    await world(c); // every table has data, so a leak shows up as rows
    for (const t of [...(await publicTables(c, ["r", "v", "m", "p"]))]) {
      const kind = t === "claim_summary" || t === "invoice_balances" ? "view" : "table";
      const res = await attempt(asAnon(c, () => c.query(`select * from public."${t}"`)));
      if (t in ANON_READABLE) expect(res, `anon ${t}`).toBeGreaterThan(0);
      else expect([0, `permission denied for ${kind} ${t}`], `anon ${t}`).toContain(res);
    }
    for (const t of Object.keys(ANON_READABLE)) {
      expect(await attempt(asAnon(c, () => c.query(`update ${t} set id=id`))), `anon update ${t}`).toBe(0);
      expect(await attempt(asAnon(c, () => c.query(`delete from ${t}`))), `anon delete ${t}`).toBe(0);
    }
    expect(await attempt(asAnon(c, () => c.query("insert into session_types(name,duration_min,fee_cents) values ('x',1,1)")))).toBe(RLS("session_types"));
    expect(await attempt(asAnon(c, () => c.query("insert into availability_rules(weekday,start_time,end_time) values (1,'00:00','01:00')")))).toBe(RLS("availability_rules"));
  }));

  it("anon cannot write any other table", () => withClient(async (c) => {
    await world(c);
    const before = await snapshot(c);
    for (const t of (await publicTables(c)).filter((x) => !(x in ANON_READABLE))) {
      const col = (await c.query("select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position limit 1", [t])).rows[0].column_name;
      for (const sql of [`update public."${t}" set "${col}" = "${col}"`, `delete from public."${t}"`]) {
        // no usable policy -> 0 rows; no privilege -> permission denied
        expect([0, `permission denied for table ${t}`], `anon ${sql}`).toContain(await attempt(asAnon(c, () => c.query(sql))));
      }
    }
    expect(await snapshot(c)).toEqual(before);
  }));

  it("every security definer function except busy_ranges is denied to anon", () => withClient(async (c) => {
    await world(c);
    const fns = (await c.query(
      `select p.proname n, (select coalesce(string_agg('null::' || format_type(t, null), ','), '') from unnest(p.proargtypes) t) args
         from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.prosecdef order by 1`)).rows;
    expect(fns.length).toBeGreaterThan(15); // the sweep must actually find the functions
    for (const f of fns.filter((x) => x.n !== "busy_ranges")) {
      const msg = await attempt(asAnon(c, () => c.query(`select public."${f.n}"(${f.args})`)));
      expect(msg, `anon ${f.n}`).toBe(`permission denied for function ${f.n}`);
    }
    // the one public function works for anon and exposes time ranges only
    const busy = await asAnon(c, () => c.query("select * from busy_ranges('2031-01-01','2031-02-01')"));
    expect(busy.fields.map((f) => f.name)).toEqual(["starts_at", "ends_at"]);
    expect(busy.rowCount).toBeGreaterThan(0);
  }));
});

// ---- 6. Staff-side confidentiality ----------------------------------------------------------------------------------------------
describe("staff roles", () => {
  it("psychologist sees everything (sanity)", () => withClient(async (c) => {
    const w = await world(c);
    for (const t of ["patients", "appointments", "form_submissions", "consents", "medical_aid_members", "claims", "clinical_notes", "note_versions", "note_addenda",
                     "invoices", "payments", "credit_notes", "claim_payments", "claim_events", "audit_log", "icd10_codes", "tasks"])
      expect((await rows(c, w.psy, t)).length, t).toBeGreaterThanOrEqual(2);
    expect((await rows(c, w.psy, "clinical_notes")).length).toBe(2);
    expect((await rows(c, w.psy, "note_versions")).length).toBe(4); // per note: the earlier draft text, and (0013) the text kept when it was signed
    expect((await rows(c, w.psy, "note_addenda")).length).toBe(2);
  }));

  it("bookkeeper, admin and associate see no clinical notes, note versions or addenda", () => withClient(async (c) => {
    const w = await world(c);
    for (const [who, u] of [["bookkeeper", w.bk], ["admin", w.adm], ["associate", w.assoc]] as const)
      for (const t of ["clinical_notes", "note_versions", "note_addenda"]) expect((await rows(c, u, t)).length, `${who} ${t}`).toBe(0);
  }));

  it("bookkeeper sees no patient, appointment, form, consent, member or claim rows, but does see billing", () => withClient(async (c) => {
    const w = await world(c);
    for (const t of ["patients", "appointments", "appointment_events", "form_submissions", "form_submission_versions", "consents", "medical_aid_members",
                     "claims", "claim_events", "icd10_codes", "tasks", "guardianships", "audit_log"])
      expect((await rows(c, w.bk, t)).length, `bookkeeper ${t}`).toBe(0);
    // controls: the bookkeeper is not simply locked out of everything
    for (const t of ["invoices", "invoice_lines", "credit_notes", "payments", "claim_payments", "claim_summary"]) expect((await rows(c, w.bk, t)).length, `bookkeeper ${t}`).toBeGreaterThan(0);
    // the summary exposes no clinical or identity columns
    expect(Object.keys((await rows(c, w.bk, "claim_summary"))[0]).sort()).toEqual(["approved_cents", "claimed_cents", "id", "invoice_id", "status", "submitted_at"]);
  }));

  it("associate and admin cannot read the confidential tables they have no policy for", () => withClient(async (c) => {
    const w = await world(c);
    for (const t of ["appointments", "form_submissions", "consents", "medical_aid_members", "claims", "invoices"]) expect((await rows(c, w.assoc, t)).length, `associate ${t}`).toBe(0);
    for (const t of ["audit_log"]) expect((await rows(c, w.adm, t)).length, `admin ${t}`).toBe(0); // audit log is psychologist-only
  }));
});

