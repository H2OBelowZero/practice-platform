import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { withClient, asUser } from "./helpers";

// supabase/seed.sql (form templates only) is run first, then supabase/seed-demo.sql with the explicit opt-in `set app.demo_seed = 'on'`, as the
// README says, all inside the usual rolled-back transaction. The demo block must not trip any billing / notes / status guard, must do NOTHING
// without the opt-in (even on an empty database), must be a no-op on a configured database, and must give patients only their own data.
const root = join(__dirname, "..", "..", "supabase");
const templates = readFileSync(join(root, "seed.sql"), "utf8");
const demo = readFileSync(join(root, "seed-demo.sql"), "utf8");
const configToml = readFileSync(join(root, "config.toml"), "utf8");
const block = demo.slice(demo.indexOf("-- BEGIN demo data"), demo.indexOf("-- END demo data"));
const U = { psy: "a0000000-0000-4000-8000-000000000001", adm: "a0000000-0000-4000-8000-000000000002", bk: "a0000000-0000-4000-8000-000000000003",
  ua: "a0000000-0000-4000-8000-000000000011", ub: "a0000000-0000-4000-8000-000000000012", ug: "a0000000-0000-4000-8000-000000000021" };
const AUDITED = 12; // invoice.issue x4, payment.record x2 (EFT + remittance), consent.grant x5 (incl. B's share_insurer, 0032), appointment.cancel x1
const PA = "b0000000-0000-4000-8000-000000000011", PB = "b0000000-0000-4000-8000-000000000012", PM = "b0000000-0000-4000-8000-000000000014";

async function run(c: Client, o: { optIn?: boolean; templates?: boolean } = {}): Promise<string[]> {
  const { optIn = true, templates: withTemplates = true } = o;
  const notices: string[] = [];
  const on = (n: { message?: string }) => { notices.push(n.message ?? ""); };
  c.on("notice", on);
  try {
    if (withTemplates) await c.query(templates);
    if (optIn) await c.query("set app.demo_seed = 'on'");
    await c.query(demo);
  } finally { c.off("notice", on); }
  return notices;
}
const one = async (c: Client, sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];

it("the demo file carries the NEVER-ON-PRODUCTION warning and every guard; seed.sql and config.toml know nothing of it", () => {
  expect(block.length).toBeGreaterThan(1000);
  expect(demo).toMatch(/NEVER RUN THIS ON PRODUCTION/);
  expect(demo).toMatch(/PUBLIC KNOWLEDGE/);
  expect(block).toMatch(/app\.demo_seed/);
  expect(block).toMatch(/from auth\.users/);
  expect(block).toMatch(/'My Practice'/);
  // the file that `supabase db reset` loads holds no accounts at all, and the config never names the demo file
  expect(templates).not.toMatch(/auth\.users|demo\.test|Demo-Passw0rd|crypt\(/);
  expect(configToml).not.toMatch(/seed-demo/);
  expect(configToml).toMatch(/sql_paths = \["\.\/seed\.sql"\]/);
  // phones are obviously invalid and addresses are on the reserved .test domain
  expect(block).not.toMatch(/\b0[6-8]\d[ -]?\d{3}[ -]?\d{4}\b/);
  expect([...block.matchAll(/[\w.]+@[\w.]+/g)].every((m) => m[0].endsWith(".test"))).toBe(true);
});

it("does nothing without the explicit opt-in, even on a completely empty database (a brand-new production project looks like this)", () => withClient(async (c) => {
  expect((await one(c, "select count(*)::int n from auth.users")).n).toBe(0);
  const notices = await run(c, { optIn: false });
  expect(notices.join("\n")).toMatch(/demo seed skipped: not opted in/);
  expect((await one(c, "select count(*)::int n from auth.users")).n).toBe(0);
  expect((await one(c, "select count(*)::int n from profiles where role <> 'patient'")).n).toBe(0);
  expect((await one(c, "select name from practices")).name).toBe("My Practice");
  await c.query("set app.demo_seed = 'yes'"); // any value other than 'on' is no opt-in either
  await c.query(demo);
  expect((await one(c, "select count(*)::int n from auth.users")).n).toBe(0);
}));

it("the form-template seed alone creates no account", () => withClient(async (c) => {
  await c.query(templates);
  expect((await one(c, "select count(*)::int n from auth.users")).n).toBe(0);
  expect((await one(c, "select count(*)::int n from form_templates")).n).toBe(12); // 9 version 1 templates + registration v2, guardian_info v2, presenting_concerns v1 (final review I5)
}));

it("the demo file does nothing until the form templates exist", () => withClient(async (c) => {
  const notices = await run(c, { templates: false });
  expect(notices.join("\n")).toMatch(/load supabase\/seed\.sql/);
  expect((await one(c, "select count(*)::int n from auth.users")).n).toBe(0);
}));

it("creates the accounts with the right roles, bcrypt passwords and email identities", () => withClient(async (c) => {
  await run(c);
  const roles = (await c.query("select u.email, p.role from auth.users u join profiles p on p.user_id = u.id order by u.email")).rows;
  expect(Object.fromEntries(roles.map((r) => [r.email, r.role]))).toEqual({
    "admin@demo.test": "admin", "bookkeeper@demo.test": "bookkeeper", "guardian@demo.test": "guardian", "patient.a@demo.test": "patient",
    "patient.b@demo.test": "patient", "patient.c@demo.test": "patient", "psychologist@demo.test": "psychologist" });
  const pw = await one(c, "select count(*)::int n from auth.users where encrypted_password like '$2%' and extensions.crypt('Demo-Passw0rd-2026', encrypted_password) = encrypted_password");
  expect(pw.n).toBe(7);
  const ids = await one(c, "select count(*)::int n, count(*) filter (where provider = 'email' and provider_id = user_id::text and identity_data ->> 'email' = email)::int ok from auth.identities");
  expect(ids).toEqual({ n: 7, ok: 7 });
  const tok = await one(c, "select count(*)::int n from auth.users where confirmation_token = '' and recovery_token = '' and email_change = '' and email_change_token_new = ''");
  expect(tok.n).toBe(7);
  const conf = await one(c, "select count(*)::int n from auth.users where email_confirmed_at is not null and raw_app_meta_data = '{\"provider\":\"email\",\"providers\":[\"email\"]}'::jsonb");
  expect(conf.n).toBe(7);
}));

it("creates the practice setup, patients, guardianship, appointments, forms, billing, claim, fee task and note", () => withClient(async (c) => {
  const notices = await run(c);
  expect(notices.join("\n")).toMatch(/demo seed loaded/);
  expect(await one(c, "select name, approval_mode, late_cancel_fee_cents from practices")).toEqual({ name: "Demo Practice", approval_mode: "request", late_cancel_fee_cents: 35000 });
  expect((await c.query("select name, duration_min, fee_cents, format from session_types order by fee_cents desc, name")).rows).toEqual([
    { name: "Initial consultation", duration_min: 60, fee_cents: 120000, format: "in_person" },
    { name: "Follow-up", duration_min: 50, fee_cents: 95000, format: "in_person" },
    { name: "Video follow-up", duration_min: 50, fee_cents: 95000, format: "video" }]);
  expect((await c.query("select weekday from availability_rules where start_time = '08:00' and end_time = '16:00' order by weekday")).rows.map((r) => r.weekday)).toEqual([1, 2, 3, 4, 5]);
  expect((await one(c, "select count(*)::int n from availability_rules")).n).toBe(5);
  expect((await one(c, "select count(*)::int n from patients")).n).toBe(4);
  expect(await one(c, "select is_minor, user_id from patients where id = $1", [PM])).toEqual({ is_minor: true, user_id: null });
  expect(await one(c, "select permissions from guardianships where patient_id = $1 and guardian_user_id = $2", [PM, U.ug])).toEqual({ permissions: { book: true, forms: true, pay: true } });
  const ap = (await c.query("select status, count(*)::int n from appointments group by status order by status")).rows;
  expect(Object.fromEntries(ap.map((r) => [r.status, r.n]))).toEqual({ attended: 3, cancelled: 1, confirmed: 2, tentative: 1 });
  expect((await one(c, "select count(*)::int n from tasks where source = 'late_cancel_fee' and status = 'open'")).n).toBe(1);
  expect((await one(c, "select count(*)::int n from consents where patient_id = $1 and granted", [PA])).n).toBe(2);
  expect((await one(c, "select count(*)::int n from form_submissions where patient_id = $1 and status = 'submitted' and submitted_by = $2", [PA, U.ua])).n).toBe(2);
  // self-pay invoice: issued, then a partial EFT leaves it part_paid
  expect(await one(c, "select status, total_cents, paid_cents, outstanding_cents from invoice_balances where patient_id = $1", [PA]))
    .toEqual({ status: "part_paid", total_cents: 95000, paid_cents: 40000, outstanding_cents: 55000 });
  expect(await one(c, "select method, reference, recorded_by from payments where invoice_id = 'c0000000-0000-4000-8000-000000000001'")).toEqual({ method: "eft", reference: "DEMO-EFT-0001", recorded_by: U.psy });
  // split invoice with a submitted claim: the invoice stays issued, the claim is submitted
  expect(await one(c, "select status, scheme_portion_cents, patient_portion_cents from invoices where patient_id = $1 and payer_type = 'split'", [PB])).toEqual({ status: "issued", scheme_portion_cents: 76000, patient_portion_cents: 19000 });
  const claim = await one(c, "select status, claimed_cents, icd10_codes, submitted_at is not null as stamped from claims where id = 'f0000000-0000-4000-8000-000000000002'");
  expect(claim).toEqual({ status: "submitted", claimed_cents: 76000, icd10_codes: ["F41.1"], stamped: true });
  // a pure medical-aid invoice (scheme owes everything, patient nothing) with its own claim and a partial scheme remittance
  expect(await one(c, "select status, scheme_portion_cents, patient_portion_cents, appointment_id from invoices where payer_type = 'medical_aid'")).toEqual({ status: "part_paid", scheme_portion_cents: 95000, patient_portion_cents: 0, appointment_id: null });
  expect(await one(c, "select status, claimed_cents from claims where id = 'f0000000-0000-4000-8000-000000000003'")).toEqual({ status: "part_paid", claimed_cents: 95000 });
  expect(await one(c, "select amount_cents, remittance_ref from claim_payments where claim_id = 'f0000000-0000-4000-8000-000000000003'")).toEqual({ amount_cents: 30000, remittance_ref: "DEMO-RA-0001" });
  expect(await one(c, "select method, amount_cents from payments where invoice_id = 'c0000000-0000-4000-8000-000000000004'")).toEqual({ method: "medical_aid", amount_cents: 30000 });
  expect((await one(c, "select count(*)::int n from claim_events where claim_id = 'f0000000-0000-4000-8000-000000000003'")).n).toBeGreaterThanOrEqual(2);
  expect((await one(c, "select count(*)::int n from claim_events where to_status = 'submitted'")).n).toBe(2);
  expect(await one(c, "select status from invoices where patient_id = $1", [PM])).toEqual({ status: "issued" });
  // patient B has real rows of every kind the isolation tests claim another patient cannot read
  expect((await one(c, "select count(*)::int n from consents where patient_id = $1 and granted", [PB])).n).toBe(3); // treatment, privacy_notice, share_insurer (0032)
  expect((await one(c, "select count(*)::int n from form_submissions where patient_id = $1 and status = 'submitted' and submitted_by = $2", [PB, U.ub])).n).toBe(3);
  expect((await one(c, "select count(*)::int n from form_submission_versions v join form_submissions s on s.id = v.submission_id where s.patient_id = $1", [PB])).n).toBe(3);
  expect((await one(c, "select granted, form_submission_id::text f from consents where patient_id = $1 and purpose = 'share_insurer'", [PB]))).toEqual({ granted: true, f: "90000000-0000-4000-8000-000000000005" });
  expect((await one(c, "select count(*)::int n from audit_log where action = 'patient.view' and entity_id = $1", [PB])).n).toBe(1);
  expect((await one(c, "select count(*)::int n from notifications_outbox where recipient = 'patient.b@demo.test' and status = 'sent'")).n).toBe(1);
  // notes: A's is a draft with fictional text; B's is signed, then amended by an addendum, with a risk flag and its psychologist-only task
  const note = await one(c, "select state, signed_at, author_id, content ->> 'subjective' as s from clinical_notes where id = '80000000-0000-4000-8000-000000000001'");
  expect(note.state).toBe("draft"); expect(note.signed_at).toBeNull(); expect(note.author_id).toBe(U.psy); expect(note.s).toMatch(/DEMO TEXT, FICTIONAL/);
  const noteB = await one(c, "select state, signed_at is not null as signed, author_id, risk ->> 'level' as level, (select count(*)::int from note_addenda a where a.note_id = n.id) as addenda, (select count(*)::int from note_versions v where v.note_id = n.id) as versions from clinical_notes n where id = '80000000-0000-4000-8000-000000000002'");
  expect(noteB).toMatchObject({ state: "amended", signed: true, author_id: U.psy, level: "moderate", addenda: 1 });
  expect(noteB.versions).toBeGreaterThanOrEqual(1);
  expect(await one(c, "select status, assignee, patient_id from tasks where source = 'risk_flag:80000000-0000-4000-8000-000000000002'")).toEqual({ status: "open", assignee: U.psy, patient_id: PB });
  // retention defaults come from the migration, not from the seed
  expect((await one(c, "select count(*)::int n from retention_policies")).n).toBe(5);
  // every invoice number is distinct and the audit trail was written by the real paths
  expect((await one(c, "select count(distinct number)::int n from invoices")).n).toBe(4);
  expect((await one(c, "select count(*)::int n from audit_log where action in ('invoice.issue','payment.record','consent.grant','appointment.cancel')")).n).toBe(AUDITED);
  // the seed leaves no impersonation behind
  expect((await one(c, "select auth.uid() as u")).u).toBeNull();
}));

it("is a no-op when auth.users already has a row", () => withClient(async (c) => {
  await c.query("insert into auth.users(id, email) values (gen_random_uuid(), 'someone@real.example')");
  const before = await one(c, "select (select count(*) from patients)::int p, (select count(*) from session_types)::int s, (select name from practices) as n");
  const notices = await run(c);
  expect(notices.join("\n")).toMatch(/demo seed skipped: auth\.users already has rows/);
  expect(await one(c, "select (select count(*) from patients)::int p, (select count(*) from session_types)::int s, (select name from practices) as n")).toEqual(before);
  expect((await one(c, "select count(*)::int n from auth.users")).n).toBe(1);
}));

it("is a no-op when the practice has already been named", () => withClient(async (c) => {
  await c.query("update practices set name = 'Real Practice'");
  const notices = await run(c);
  expect(notices.join("\n")).toMatch(/demo seed skipped: the practice has already been configured/);
  expect((await one(c, "select count(*)::int n from auth.users")).n).toBe(0);
  expect((await one(c, "select name from practices")).name).toBe("Real Practice");
}));

it("running it twice changes nothing the second time", () => withClient(async (c) => {
  await run(c);
  const n1 = (await one(c, "select count(*)::int n from invoices")).n;
  const notices = await run(c);
  expect(notices.join("\n")).toMatch(/skipped/);
  expect((await one(c, "select count(*)::int n from invoices")).n).toBe(n1);
}));

it("a seeded patient sees only their own data; the guardian sees the child; staff roles see what the matrix says", () => withClient(async (c) => {
  await run(c);
  await asUser(c, U.ua, async () => {
    expect((await c.query("select id from patients")).rows.map((r) => r.id)).toEqual([PA]);
    expect((await c.query("select distinct patient_id from invoices")).rows.map((r) => r.patient_id)).toEqual([PA]);
    expect((await c.query("select distinct patient_id from appointments")).rows.map((r) => r.patient_id)).toEqual([PA]);
    expect((await c.query("select 1 from clinical_notes")).rowCount).toBe(0);
    expect((await c.query("select 1 from claims")).rowCount).toBe(0);
    expect((await c.query("select 1 from medical_aid_members")).rowCount).toBe(0);
    expect((await c.query("select distinct patient_id from consents")).rows.map((r) => r.patient_id)).toEqual([PA]);
    expect((await c.query("select distinct patient_id from form_submissions")).rows.map((r) => r.patient_id)).toEqual([PA]);
  });
  await asUser(c, U.ub, async () => {
    expect((await c.query("select distinct patient_id from invoices")).rows.map((r) => r.patient_id)).toEqual([PB]);
    expect((await c.query("select 1 from medical_aid_members")).rowCount).toBe(1);
    expect((await c.query("select 1 from payments")).rowCount).toBe(1); // B's own remittance payment
    expect((await c.query("select 1 from consents")).rowCount).toBe(3); // incl. share_insurer (0032)
    expect((await c.query("select 1 from clinical_notes")).rowCount).toBe(0); // the patient never reads the clinical record
  });
  await asUser(c, U.ug, async () => {
    expect((await c.query("select id from patients")).rows.map((r) => r.id)).toEqual([PM]);
    expect((await c.query("select 1 from invoices")).rowCount).toBe(1);
  });
  await asUser(c, U.adm, async () => { expect((await c.query("select 1 from clinical_notes")).rowCount).toBe(0); });
  await asUser(c, U.bk, async () => {
    expect((await c.query("select 1 from patients")).rowCount).toBe(0);
    expect((await c.query("select 1 from invoices")).rowCount).toBe(4);
    expect((await c.query("select 1 from claims")).rowCount).toBe(0);
  });
  await asUser(c, U.psy, async () => { expect((await c.query("select 1 from clinical_notes")).rowCount).toBe(2); });
}));

// ---- direct-API isolation ------------------------------------------------------------------------------------------------------------------
// The same checks as tests/e2e/access.spec.ts ("direct API requests"), at SQL level as the `authenticated` / `anon` roles, so the e2e expectations are
// known to hold in the schema before the first staging run. Every "cannot read" check has a POSITIVE CONTROL: the identical query, run without
// restriction (or as the psychologist where the table is hidden from the owner by design), must find at least one row of patient B's. Only an
// empty result or a permission-denied error counts as "blocked"; any other error (a misspelt table or column) fails the test.
const INV_SPLIT = "c0000000-0000-4000-8000-000000000002", INV_MA = "c0000000-0000-4000-8000-000000000004";
const NOTE_B = "80000000-0000-4000-8000-000000000002", CLAIM_MA = "f0000000-0000-4000-8000-000000000003", MEM_B = "f0000000-0000-4000-8000-000000000001";
const B_ROWS: Record<string, string> = {
  patients: `select 1 from patients where id = '${PB}'`,
  appointments: `select 1 from appointments where patient_id = '${PB}'`,
  invoices: `select 1 from invoices where patient_id = '${PB}'`,
  invoice_lines: `select 1 from invoice_lines where invoice_id = '${INV_SPLIT}'`,
  payments: `select 1 from payments where invoice_id = '${INV_MA}'`,
  form_submissions: `select 1 from form_submissions where patient_id = '${PB}'`,
  consents: `select 1 from consents where patient_id = '${PB}'`,
  medical_aid_members: `select 1 from medical_aid_members where id = '${MEM_B}'`,
  clinical_notes: `select 1 from clinical_notes where patient_id = '${PB}'`,
  note_versions: `select 1 from note_versions where note_id = '${NOTE_B}'`,
  note_addenda: `select 1 from note_addenda where note_id = '${NOTE_B}'`,
  claims: `select 1 from claims where member_id = '${MEM_B}'`,
  claim_events: `select 1 from claim_events where claim_id = '${CLAIM_MA}'`,
  claim_payments: `select 1 from claim_payments where claim_id = '${CLAIM_MA}'`,
  claim_summary: `select 1 from claim_summary where invoice_id = '${INV_MA}'`,
  audit_log: `select 1 from audit_log where entity_id = '${PB}'`,
  tasks: `select 1 from tasks where patient_id = '${PB}'`,
  risk_tasks: `select 1 from tasks where source like 'risk_flag:%'`,
  notifications_outbox: `select 1 from notifications_outbox where recipient = 'patient.b@demo.test'`,
  retention_policies: `select 1 from retention_policies`,
};
/** rows seen, or "denied" for a permission error; anything else (missing table or column, syntax) is a failed test */
async function seen(c: Client, sql: string): Promise<number | "denied"> {
  try { return (await c.query(sql)).rowCount ?? 0; }
  catch (e) { if (/permission denied/i.test((e as Error).message)) return "denied"; throw e; }
}
async function blocked(c: Client, who: string, names: string[]) {
  for (const n of names) expect([0, "denied"], `${who} reading ${n}`).toContain(await seen(c, B_ROWS[n]));
}
async function controls(c: Client, names: string[]) { // as the owner, or as the psychologist for the view that is empty without a role
  for (const n of names) {
    const got = n === "claim_summary" || n === "risk_tasks" ? await asUser(c, U.psy, () => seen(c, B_ROWS[n])) : await seen(c, B_ROWS[n]);
    expect(got, `positive control for ${n}`).not.toBe("denied");
    expect(got as number, `positive control for ${n}`).toBeGreaterThanOrEqual(1);
  }
}
const ALL = Object.keys(B_ROWS);
const PATIENT_TABLES = ["patients", "appointments", "invoices", "invoice_lines", "payments", "form_submissions", "consents", "medical_aid_members"];

it("the blocked-check helper fails on a misspelt table or column (an error is not 'no rows')", () => withClient(async (c) => {
  await run(c);
  await expect(seen(c, "select 1 from patientz")).rejects.toThrow(/does not exist/);
  await expect(seen(c, "select 1 from patients where idd = 1")).rejects.toThrow(/does not exist/);
  expect(await seen(c, `select 1 from patients where id = '${PB}'`)).toBe(1);
}));

it("every table the isolation checks cover really holds rows of patient B (so 'blocked' is meaningful)", () => withClient(async (c) => {
  await run(c);
  await controls(c, ALL);
}));

it("direct-API isolation: patient A cannot read patient B's rows, anywhere", () => withClient(async (c) => {
  await run(c);
  await controls(c, ALL);
  await asUser(c, U.ua, async () => {
    await blocked(c, "patient A", ALL);
    const err = async (sql: string, p: unknown[] = []) => { try { await c.query(sql, p); return ""; } catch (e) { return (e as Error).message; } };
    expect(await err("select book_appointment($1, 'd0000000-0000-4000-8000-000000000002', now() + interval '2 days')", [PB])).toMatch(/forbidden/);
    expect(await err(`select record_payment('${INV_SPLIT}', 'eft', 100, 'X', null)`)).toMatch(/forbidden/);
    expect(await err(`select record_scheme_remittance('${CLAIM_MA}', 100, 'X')`)).toMatch(/forbidden/);
    expect(await err("select cancel_appointment('e0000000-0000-4000-8000-000000000005', 'x', false)")).toMatch(/forbidden/);
    expect(await err("select audit_append(null, 'patient', 'forged', null, null, null)")).toMatch(/permission denied/);
    expect(await err("insert into audit_log(action) values ('forged')")).toMatch(/permission denied|row-level security/);
    expect((await c.query(`update patients set first_name = 'Hacked' where id = '${PB}'`)).rowCount).toBe(0);
    expect((await c.query(`delete from appointments where patient_id = '${PB}'`).catch(() => ({ rowCount: 0 }))).rowCount).toBe(0);
  });
  // B's rows are untouched afterwards
  expect((await one(c, `select first_name from patients where id = '${PB}'`)).first_name).toBe("Pieter");
  expect((await one(c, `select count(*)::int n from appointments where patient_id = '${PB}'`)).n).toBeGreaterThanOrEqual(2);
}));

it("direct-API isolation: patient B, the guardian and patient A are each limited to their own rows (positive both ways)", () => withClient(async (c) => {
  await run(c);
  await asUser(c, U.ub, async () => { for (const n of PATIENT_TABLES) expect(await seen(c, B_ROWS[n]), `B reading own ${n}`).toBeGreaterThanOrEqual(1); });
  await asUser(c, U.ug, async () => { await blocked(c, "guardian of Sipho", PATIENT_TABLES); }); // B's rows, not the child's
}));

it("direct-API isolation: the admin reads no clinical data; the psychologist does (control)", () => withClient(async (c) => {
  await run(c);
  await controls(c, ["clinical_notes", "note_versions", "note_addenda", "risk_tasks"]);
  await asUser(c, U.adm, async () => { await blocked(c, "admin", ["clinical_notes", "note_versions", "note_addenda", "risk_tasks"]); });
}));

it("direct-API isolation: the bookkeeper reads no clinical or patient data and cannot record payments", () => withClient(async (c) => {
  await run(c);
  const names = ["clinical_notes", "note_versions", "note_addenda", "patients", "form_submissions", "consents", "medical_aid_members", "claims", "claim_events", "audit_log", "tasks", "risk_tasks", "notifications_outbox", "retention_policies"];
  await controls(c, names);
  await asUser(c, U.bk, async () => {
    await blocked(c, "bookkeeper", names);
    expect(await seen(c, "select 1 from invoice_balances")).toBeGreaterThan(0); // what the bookkeeper may read is there
    expect(await seen(c, B_ROWS.claim_payments)).toBeGreaterThan(0); // remittance amounts are readable by design (no names, no codes)
    expect(await seen(c, `select 1 from claim_summary where invoice_id = '${INV_MA}'`)).toBeGreaterThan(0);
    await expect(c.query(`select record_payment('${INV_SPLIT}', 'eft', 100, 'X', null)`)).rejects.toThrow(/forbidden/);
  });
}));

it("direct-API isolation: an anonymous caller reads nothing", () => withClient(async (c) => {
  await run(c);
  const names = ["patients", "appointments", "invoices", "payments", "clinical_notes", "form_submissions", "consents", "audit_log", "tasks"];
  await controls(c, names);
  await c.query("set local role anon");
  try {
    await blocked(c, "anon", names);
    await expect(c.query(`select record_payment('${INV_SPLIT}', 'payfast', 100, 'PF-1', null)`)).rejects.toThrow(/permission denied/);
  } finally { await c.query("reset role"); }
}));
