// Shared fixtures for the billing test files (not itself a test file).
import type { Client } from "pg";
import { asUser, mkUser } from "./helpers";

export type Seed = Awaited<ReturnType<typeof seed>>;

/** every kind of staff, two patients with their own users, a current and an expired guardian of p1 */
export async function seed(c: Client) {
  const psy = await mkUser(c, "psychologist"), adm = await mkUser(c, "admin"), bk = await mkUser(c, "bookkeeper");
  const assoc = await mkUser(c, "associate");
  const u1 = await mkUser(c, "patient"), u2 = await mkUser(c, "patient");
  const p1 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'A','A') returning id", [u1])).rows[0].id as string;
  const p2 = (await c.query("insert into patients(user_id,first_name,last_name) values ($1,'B','B') returning id", [u2])).rows[0].id as string;
  const g = await mkUser(c, "guardian"), gOld = await mkUser(c, "guardian");
  await c.query("insert into guardianships(guardian_user_id,patient_id) values ($1,$2)", [g, p1]);
  await c.query("insert into guardianships(guardian_user_id,patient_id,valid_to) values ($1,$2,'2000-01-01')", [gOld, p1]);
  return { psy, adm, bk, assoc, u1, u2, p1, p2, g, gOld };
}

/** superuser setup insert (the brief's insert order): an invoice that is already issued */
export async function mkInvoice(c: Client, patient: string, o: { total?: number; status?: string; payer?: string; scheme?: number } = {}) {
  const total = o.total ?? 100000, scheme = o.scheme ?? 0;
  return (await c.query(
    "insert into invoices(patient_id,total_cents,scheme_portion_cents,patient_portion_cents,payer_type,status) values ($1,$2::int,$3::int,$2::int-$3::int,$4,$5) returning id",
    [patient, total, scheme, o.payer ?? "self", o.status ?? "issued"])).rows[0].id as string;
}

/** superuser setup: the patient's share_insurer consent, which a claim needs before it can be submitted (0032). No audit row, no task. */
export const grantInsurerConsent = (c: Client, patient: string) => c.query(
  "insert into consents(patient_id,purpose,granted,granted_at) values ($1,'share_insurer',true,now()) on conflict (patient_id,purpose) do update set granted=true, granted_at=now(), withdrawn_at=null",
  [patient]);

/** a medical-aid invoice (scheme 80% by default) plus a member of the patient, who has given the share_insurer consent */
export async function mkMaInvoice(c: Client, patient: string, total = 100000, scheme = 80000) {
  await grantInsurerConsent(c, patient);
  const i = await mkInvoice(c, patient, { total, scheme, payer: "medical_aid" });
  const m = (await c.query("insert into medical_aid_members(patient_id,scheme,member_number) values ($1,'Discovery','123') returning id", [patient])).rows[0].id as string;
  return { i, m };
}

export const status = async (c: Client, i: string) => (await c.query("select status from invoices where id=$1", [i])).rows[0].status as string;
export const paid = async (c: Client, i: string) => (await c.query("select invoice_paid_cents($1) v", [i])).rows[0].v as number;
export const count = (c: Client, u: string, table: string) => asUser(c, u, async () => (await c.query(`select 1 from ${table}`)).rowCount);
export const as = (c: Client, u: string, sql: string, params: unknown[] = []) => asUser(c, u, () => c.query(sql, params));

let refSeq = 0;
/** manual payment through the public function; eft / card_machine need a reference, so one is made up unless given */
export const pay = (c: Client, u: string, i: string, method: string, amount: number, ref: string | null = null, on: string | null = null, allowDup = false) =>
  as(c, u, "select record_payment($1,$2,$3,$4,null,coalesce($5::date, (now() at time zone 'Africa/Johannesburg')::date),$6) id",
    [i, method, amount, ref ?? (method === "cash" ? null : `AUTO-${++refSeq}`), on, allowDup]);

export async function guardianWith(c: Client, patient: string, permissions: string, validTo: string | null = null) {
  const g = await mkUser(c, "guardian");
  await c.query("insert into guardianships(guardian_user_id,patient_id,permissions,valid_to) values ($1,$2,$3,$4)", [g, patient, permissions, validTo]);
  return g;
}
