import { it, expect } from "vitest";
import type { Client } from "pg";
import { asUser, asService, mkUser, withClient } from "./helpers";

// 0011: invite_patient(): staff only, eligibility, 10 minute throttle on the database clock.
const mk = async (c: Client, o: { email?: string | null; status?: string; minor?: boolean; user?: string | null; invited?: string | null } = {}) =>
  (await c.query(
    "insert into patients(first_name,last_name,email,status,is_minor,user_id,portal_invited_at) values ('A','B',$1,$2,$3,$4,$5::timestamptz) returning id",
    [o.email === undefined ? "a@b.test" : o.email, o.status ?? "active", o.minor ?? false, o.user ?? null, o.invited ?? null])).rows[0].id as string;
const invite = (c: Client, u: string, id: string) => asUser(c, u, async () => (await c.query("select invite_patient($1) as ts", [id])).rows[0].ts as Date);
const stamp = async (c: Client, id: string) => (await c.query("select portal_invited_at is not null as set, portal_invited_at = now() as is_now from patients where id=$1", [id])).rows[0];

it("psychologist and admin invite: sets portal_invited_at to the database now() and returns it", () => withClient(async (c) => {
  for (const role of ["psychologist", "admin"]) {
    const u = await mkUser(c, role), id = await mk(c);
    const ts = await invite(c, u, id);
    expect(ts).toBeInstanceOf(Date);
    expect(await stamp(c, id)).toEqual({ set: true, is_now: true });
  }
}));

it("everyone else is refused: other staff, patients, guardians, anonymous and service role (no auth.uid)", () => withClient(async (c) => {
  const id = await mk(c);
  for (const role of ["associate", "bookkeeper", "patient", "guardian"]) {
    const u = await mkUser(c, role);
    await expect(invite(c, u, id), role).rejects.toThrow(/forbidden/);
  }
  await expect(asService(c, () => c.query("select invite_patient($1)", [id]))).rejects.toThrow(/forbidden/);
  await expect(c.query("set local role anon").then(() => c.query("select invite_patient($1)", [id])).finally(() => c.query("reset role"))).rejects.toThrow(/permission denied/);
  expect((await stamp(c, id)).set).toBe(false);
}));

it("refuses an unknown, registered, archived, minor or email-less patient", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist"), acct = await mkUser(c, "patient");
  await expect(invite(c, psy, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/patient_not_found/);
  await expect(invite(c, psy, await mk(c, { user: acct }))).rejects.toThrow(/already_registered/);
  await expect(invite(c, psy, await mk(c, { status: "archived" }))).rejects.toThrow(/patient_archived/);
  await expect(invite(c, psy, await mk(c, { minor: true }))).rejects.toThrow(/patient_minor/);
  await expect(invite(c, psy, await mk(c, { email: null }))).rejects.toThrow(/no_email/);
  await expect(invite(c, psy, await mk(c, { email: "  " }))).rejects.toThrow(/no_email/);
}));

it("throttle: a second invitation inside 10 minutes raises invite_too_soon; after 10 minutes it is allowed again", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist");
  const fresh = await mk(c, { invited: new Date(Date.now() - 2 * 60_000).toISOString() });
  await expect(invite(c, psy, fresh)).rejects.toThrow(/invite_too_soon/);
  const justUnder = await mk(c, { invited: new Date(Date.now() - 9 * 60_000).toISOString() });
  await expect(invite(c, psy, justUnder)).rejects.toThrow(/invite_too_soon/);
  const old = await mk(c, { invited: new Date(Date.now() - 11 * 60_000).toISOString() });
  await invite(c, psy, old);
  expect((await stamp(c, old)).is_now).toBe(true);
  // the very first invitation (null) is always fine, and a second call right after it is refused
  const first = await mk(c);
  await invite(c, psy, first);
  await expect(invite(c, psy, first)).rejects.toThrow(/invite_too_soon/);
}));
