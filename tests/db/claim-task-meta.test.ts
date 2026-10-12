import { it, expect } from "vitest";
import type { Client } from "pg";
import { withClient } from "./helpers";
import { seed, mkMaInvoice, as } from "./billing-helpers";

// 0019: the task a claim rejection creates carries meta = {claim_id}; everything else about it is as in 0005.
async function setup(c: Client) {
  const s = await seed(c);
  const { i, m } = await mkMaInvoice(c, s.p1);
  const claim = (await as(c, s.psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,80000,'{F41.1}') returning id", [i, m])).rows[0].id as string;
  return { ...s, i, m, claim };
}
const setStatus = (c: Client, u: string, id: string, st: string, extra = "") => as(c, u, `update claims set status=$2 ${extra} where id=$1`, [id, st]);
const tasks = async (c: Client) => (await c.query("select title, priority, status, source, patient_id, meta from tasks where source='claim_rejected' order by created_at, id")).rows;

it("a rejection creates one task with meta.claim_id, the invoice's patient, a fixed title and no clinical text", () => withClient(async (c) => {
  const { psy, claim, p1 } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  expect(await tasks(c)).toHaveLength(0);
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='Diagnosis F41.1 not covered'");
  const t = await tasks(c);
  expect(t).toEqual([{ title: "Claim rejected: follow up and resubmit", priority: "high", status: "open", source: "claim_rejected", patient_id: p1, meta: { claim_id: claim } }]);
  expect(Object.keys(t[0].meta)).toEqual(["claim_id"]);
  expect(JSON.stringify(t[0])).not.toMatch(/F41|Diagnosis|covered|Discovery|123/); // no reason, code, scheme or member number
}));

it("still one task per rejection: editing a rejected claim adds none, a second rejection adds a second (same claim id)", () => withClient(async (c) => {
  const { psy, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='One'");
  await as(c, psy, "update claims set rejection_reason='One, corrected', preauth_ref='PA' where id=$1", [claim]);
  expect(await tasks(c)).toHaveLength(1);
  await setStatus(c, psy, claim, "draft");
  await setStatus(c, psy, claim, "submitted");
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='Two'");
  const t = await tasks(c);
  expect(t).toHaveLength(2);
  expect(t.map((x) => x.meta.claim_id)).toEqual([claim, claim]);
  // a resubmission straight from rejected, then a third rejection
  await setStatus(c, psy, claim, "submitted");
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='Three'");
  expect(await tasks(c)).toHaveLength(3);
}));

it("a rejection by the admin makes the same task; the task is visible to psychologist and admin only", () => withClient(async (c) => {
  const { psy, adm, bk, assoc, u1, g, claim } = await setup(c);
  await setStatus(c, adm, claim, "submitted");
  await setStatus(c, adm, claim, "rejected", ", rejection_reason='Not covered'");
  const seen = async (u: string) => (await as(c, u, "select meta from tasks where source='claim_rejected'")).rows;
  for (const u of [psy, adm]) expect(await seen(u)).toEqual([{ meta: { claim_id: claim } }]);
  for (const u of [bk, assoc, u1, g]) expect(await seen(u)).toEqual([]);
}));

it("the trigger function is still not executable through the API", () => withClient(async (c) => {
  for (const role of ["anon", "authenticated", "service_role"])
    expect((await c.query("select has_function_privilege($1, 'claims_events()', 'execute') ok", [role])).rows[0].ok, role).toBe(false);
  // the events log keeps its shape: the rejection reason is in the event detail for staff, nowhere else
  const { psy, claim } = await setup(c);
  await setStatus(c, psy, claim, "submitted");
  await setStatus(c, psy, claim, "rejected", ", rejection_reason='Why'");
  const ev = (await c.query("select detail from claim_events where claim_id=$1 and to_status='rejected'", [claim])).rows;
  expect(ev).toEqual([{ detail: { reason: "Why" } }]);
}));
