import { it, expect } from "vitest";
import type { Client } from "pg";
import { asUser, withClient } from "./helpers";
import { seed, mkMaInvoice, as } from "./billing-helpers";

// 0032 (final review I4, POPIA): a claim goes to the scheme only with the patient's current share_insurer consent, on submission and on every resubmission.

async function setup(c: Client) {
  const s = await seed(c);
  const { i, m } = await mkMaInvoice(c, s.p1); // mkMaInvoice grants the consent; the tests below take it away where needed
  const mk = async (cents = 30000) =>
    (await as(c, s.psy, "insert into claims(invoice_id,member_id,claimed_cents,icd10_codes) values ($1,$2,$3,'{F41.1}') returning id", [i, m, cents])).rows[0].id as string;
  return { ...s, i, m, mk };
}
const setStatus = (c: Client, u: string, id: string, st: string, extra = "") => as(c, u, `update claims set status=$2 ${extra} where id=$1`, [id, st]);
const cs = async (c: Client, id: string) => (await c.query("select status from claims where id=$1", [id])).rows[0].status as string;
const withdraw = (c: Client, p: string) => c.query("update consents set granted=false, withdrawn_at=now() where patient_id=$1 and purpose='share_insurer'", [p]);
const NO_CONSENT = /share_insurer_consent_required/;

it("without a share_insurer consent nobody can mark a claim submitted (psychologist, admin, owner); a draft can still be opened and edited", () => withClient(async (c) => {
  const { psy, adm, p1, i, m, mk } = await setup(c);
  await withdraw(c, p1); // not (or no longer) given
  const a = await mk();
  await as(c, adm, "update claims set tariff_code='86205' where id=$1", [a]); // drafts are fine
  for (const u of [psy, adm]) await expect(setStatus(c, u, a, "submitted"), u).rejects.toThrow(NO_CONSENT);
  await expect(c.query("insert into claims(invoice_id,member_id,status,claimed_cents,icd10_codes) values ($1,$2,'submitted',100,'{F41.1}')", [i, m])).rejects.toThrow(NO_CONSENT);
  expect(await cs(c, a)).toBe("draft");
  // the patient gives it (a staff-recorded grant here; patients do it by submitting the form) and the same move works
  await c.query("select set_consent($1,'share_insurer',true,null)", [p1]);
  await setStatus(c, psy, a, "submitted");
  expect(await cs(c, a)).toBe("submitted");
}));

it("a withdrawn consent blocks resubmission (rejected or accepted -> submitted) but not the outcome of a claim already sent", () => withClient(async (c) => {
  const { psy, adm, p1, u1, mk } = await setup(c);
  const a = await mk(30000), b = await mk(20000), d = await mk(10000);
  for (const x of [a, b, d]) await setStatus(c, psy, x, "submitted");
  await setStatus(c, adm, a, "rejected", ", rejection_reason='missing auth'");
  await setStatus(c, adm, b, "accepted", ", approved_cents=20000");
  // the patient withdraws through the portal (set_consent as the patient)
  await asUser(c, u1, () => c.query("select set_consent($1,'share_insurer',false,null)", [p1]), { aal: "aal1" });
  await expect(setStatus(c, psy, a, "submitted")).rejects.toThrow(NO_CONSENT);
  await expect(setStatus(c, psy, b, "submitted")).rejects.toThrow(NO_CONSENT);
  // already with the scheme: its answer and its money are still recorded
  await setStatus(c, adm, d, "accepted", ", approved_cents=10000");
  await as(c, adm, "select record_scheme_remittance($1,10000,'RA-1')", [d]);
  expect([await cs(c, a), await cs(c, b), await cs(c, d)]).toEqual(["rejected", "accepted", "paid"]);
  // returning to draft and editing is still allowed; submitting again waits for a new consent
  await setStatus(c, psy, a, "draft");
  await expect(setStatus(c, psy, a, "submitted")).rejects.toThrow(NO_CONSENT);
}));

it("the consent must be the invoice patient's own: another patient's consent does not count", () => withClient(async (c) => {
  const { psy, p1, p2, mk } = await setup(c);
  await withdraw(c, p1);
  await c.query("insert into consents(patient_id,purpose,granted,granted_at) values ($1,'share_insurer',true,now())", [p2]);
  const a = await mk();
  await expect(setStatus(c, psy, a, "submitted")).rejects.toThrow(NO_CONSENT);
}));
