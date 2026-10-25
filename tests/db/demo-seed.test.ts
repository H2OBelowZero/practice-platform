import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { withClient, asUser } from "./helpers";

// The whole of supabase/seed.sql is run (as `supabase db reset` does); its demo block (between "-- BEGIN demo data" and "-- END demo data") runs here as the owner, inside the usual
// rolled-back transaction. It must not trip any billing / notes / status guard, must be a no-op on a configured database, and must give
// patients only their own data.
const seed = readFileSync(join(__dirname, "..", "..", "supabase", "seed.sql"), "utf8");
const block = seed.slice(seed.indexOf("-- BEGIN demo data"), seed.indexOf("-- END demo data"));
const U = { psy: "a0000000-0000-4000-8000-000000000001", adm: "a0000000-0000-4000-8000-000000000002", bk: "a0000000-0000-4000-8000-000000000003",
  ua: "a0000000-0000-4000-8000-000000000011", ub: "a0000000-0000-4000-8000-000000000012", ug: "a0000000-0000-4000-8000-000000000021" };
const PA = "b0000000-0000-4000-8000-000000000011", PB = "b0000000-0000-4000-8000-000000000012", PM = "b0000000-0000-4000-8000-000000000014";

async function run(c: Client): Promise<string[]> {
  const notices: string[] = [];
  const on = (n: { message?: string }) => { notices.push(n.message ?? ""); };
  c.on("notice", on);
  try { await c.query(seed); } finally { c.off("notice", on); } // the whole file, as `supabase db reset` runs it: templates first, then the demo block
  return notices;
}
const one = async (c: Client, sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows[0];

it("the block is delimited and carries the FICTIONAL / LOCAL-ONLY warning and the guard", () => {
  expect(block.length).toBeGreaterThan(1000);
  expect(block).toMatch(/FICTIONAL, LOCAL \/ STAGING ONLY/);
  expect(block).toMatch(/PUBLIC KNOWLEDGE/);
  expect(block).toMatch(/from auth\.users/);
  expect(block).toMatch(/'My Practice'/);
});

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
  expect(await one(c, "select status, scheme_portion_cents, patient_portion_cents from invoices where patient_id = $1", [PB])).toEqual({ status: "issued", scheme_portion_cents: 76000, patient_portion_cents: 19000 });
  const claim = await one(c, "select status, claimed_cents, icd10_codes, submitted_at is not null as stamped from claims");
  expect(claim).toEqual({ status: "submitted", claimed_cents: 76000, icd10_codes: ["F41.1"], stamped: true });
  expect((await one(c, "select count(*)::int n from claim_events where to_status = 'submitted'")).n).toBe(1);
  expect(await one(c, "select status from invoices where patient_id = $1", [PM])).toEqual({ status: "issued" });
  // note: a draft with fictional text, never signed
  const note = await one(c, "select state, signed_at, author_id, content ->> 'subjective' as s from clinical_notes");
  expect(note.state).toBe("draft"); expect(note.signed_at).toBeNull(); expect(note.author_id).toBe(U.psy); expect(note.s).toMatch(/DEMO TEXT, FICTIONAL/);
  // retention defaults come from the migration, not from the seed
  expect((await one(c, "select count(*)::int n from retention_policies")).n).toBe(5);
  // every invoice number is distinct and the audit trail was written by the real paths
  expect((await one(c, "select count(distinct number)::int n from invoices")).n).toBe(3);
  expect((await one(c, "select count(*)::int n from audit_log where action in ('invoice.issue','payment.record','consent.grant','appointment.cancel')")).n).toBe(7);
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
  });
  await asUser(c, U.ub, async () => {
    expect((await c.query("select distinct patient_id from invoices")).rows.map((r) => r.patient_id)).toEqual([PB]);
    expect((await c.query("select 1 from medical_aid_members")).rowCount).toBe(1);
  });
  await asUser(c, U.ug, async () => {
    expect((await c.query("select id from patients")).rows.map((r) => r.id)).toEqual([PM]);
    expect((await c.query("select 1 from invoices")).rowCount).toBe(1);
  });
  await asUser(c, U.adm, async () => { expect((await c.query("select 1 from clinical_notes")).rowCount).toBe(0); });
  await asUser(c, U.bk, async () => {
    expect((await c.query("select 1 from patients")).rowCount).toBe(0);
    expect((await c.query("select 1 from invoices")).rowCount).toBe(3);
    expect((await c.query("select 1 from claims")).rowCount).toBe(0);
  });
  await asUser(c, U.psy, async () => { expect((await c.query("select 1 from clinical_notes")).rowCount).toBe(1); });
}));
