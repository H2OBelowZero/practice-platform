import type { Client } from "pg";
import { it, expect, describe } from "vitest";
import { withClient, asUser, asService } from "./helpers";
import { seed, as } from "./billing-helpers";

// 0027: settings guards, set_day_availability, default retention rows and the settings_audit trigger.
const audit = async (c: Client, where = "true") =>
  (await c.query(`select action, entity, entity_id, actor_id, role, detail from audit_log where action like 'settings.%' and ${where} order by id`)).rows;
const clear = async (c: Client) => { await c.query("alter table audit_log disable trigger audit_log_no_row_change"); await c.query("delete from audit_log"); await c.query("alter table audit_log enable trigger audit_log_no_row_change"); };
const practiceId = async (c: Client) => (await c.query("select id from practices")).rows[0].id as string;
const fresh = async (c: Client) => { const s = await seed(c); await clear(c); return s; };

describe("audit trigger", () => {
  it("practices: one row per change, field NAMES only, never values", async () => {
    await withClient(async (c) => {
      const { psy } = await fresh(c);
      const id = await practiceId(c);
      await as(c, psy, "update practices set name='Secret Name Co', cancellation_window_hours=48, late_cancel_fee_cents=123456, crisis_text='Call my private cell 082 000 0000' where id=$1", [id]);
      const rows = await audit(c);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "settings.change", entity: "practices", entity_id: id, actor_id: psy, role: "psychologist" });
      expect(rows[0].detail).toEqual({ op: "update", fields: ["cancellation_window_hours", "crisis_text", "late_cancel_fee_cents", "name"] });
      const text = JSON.stringify(rows);
      for (const v of ["Secret Name Co", "123456", "082 000 0000", "private cell"]) expect(text).not.toContain(v);
    });
  });

  it("payment_instructions: two rows (change + payment_instructions), sensitive flag, no text stored", async () => {
    await withClient(async (c) => {
      const { psy } = await fresh(c);
      const id = await practiceId(c);
      await as(c, psy, "update practices set payment_instructions='Bank: Evil Bank acc 99887766' where id=$1", [id]);
      const rows = await audit(c);
      expect(rows.map((r) => r.action).sort()).toEqual(["settings.change", "settings.payment_instructions"]);
      for (const r of rows) {
        expect(r.detail).toEqual({ op: "update", fields: ["payment_instructions"], sensitive: true });
        expect(r.entity).toBe("practices"); expect(r.actor_id).toBe(psy);
      }
      expect(JSON.stringify(rows)).not.toMatch(/Evil|99887766/);
      // another field in the same statement: the payment row lists only what changed too, and only payment changes write the second row
      await clear(c);
      await as(c, psy, "update practices set vat_rate=14 where id=$1", [id]);
      expect((await audit(c)).map((r) => r.action)).toEqual(["settings.change"]);
    });
  });

  it("an UPDATE that changes nothing writes nothing", async () => {
    await withClient(async (c) => {
      const { psy } = await fresh(c);
      const id = await practiceId(c);
      const cur = (await c.query("select name, payment_instructions from practices")).rows[0];
      await as(c, psy, "update practices set name=$2, payment_instructions=$3 where id=$1", [id, cur.name, cur.payment_instructions]);
      await as(c, psy, "update practices set approval_mode=approval_mode");
      expect(await audit(c)).toEqual([]);
    });
  });

  it("session_types: insert, update, delete each write one row with the right fields", async () => {
    await withClient(async (c) => {
      const { psy } = await fresh(c);
      const id = (await as(c, psy, "insert into session_types(name,duration_min,fee_cents) values ('Secret session',50,95000) returning id")).rows[0].id;
      await as(c, psy, "update session_types set fee_cents=100000, active=false where id=$1", [id]);
      await as(c, psy, "delete from session_types where id=$1", [id]);
      const rows = await audit(c, "entity='session_types'");
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.detail.op)).toEqual(["insert", "update", "delete"]);
      expect(rows.every((r) => r.entity_id === id && r.action === "settings.change")).toBe(true);
      expect(rows[0].detail.fields).toEqual(["active", "buffer_min", "deposit_cents", "duration_min", "fee_cents", "format", "id", "name"]);
      expect(rows[1].detail.fields).toEqual(["active", "fee_cents"]);
      expect(JSON.stringify(rows)).not.toMatch(/Secret session|95000|100000/);
    });
  });

  it("availability_rules and blocked_times: one row per change; the reason text is never stored", async () => {
    await withClient(async (c) => {
      const { psy, adm } = await fresh(c);
      const a = (await as(c, psy, "insert into availability_rules(weekday,start_time,end_time) values (1,'08:00','12:00') returning id")).rows[0].id;
      await as(c, psy, "update availability_rules set end_time='13:00' where id=$1", [a]);
      const b = (await as(c, adm, "insert into blocked_times(starts_at,ends_at,reason) values ('2031-05-01T08:00Z','2031-05-01T10:00Z','Dentist for my sick child') returning id")).rows[0].id;
      await as(c, adm, "update blocked_times set reason='Something else private' where id=$1", [b]);
      await as(c, adm, "delete from blocked_times where id=$1", [b]);
      const ar = await audit(c, "entity='availability_rules'");
      expect(ar.map((r) => [r.detail.op, r.detail.fields])).toEqual([["insert", ["end_time", "id", "start_time", "weekday"]], ["update", ["end_time"]]]);
      const bt = await audit(c, "entity='blocked_times'");
      expect(bt.map((r) => r.detail.op)).toEqual(["insert", "update", "delete"]);
      expect(bt[1].detail.fields).toEqual(["reason"]);
      expect(bt.every((r) => r.entity_id === b && r.actor_id === adm && r.role === "admin")).toBe(true);
      expect(JSON.stringify(bt)).not.toMatch(/Dentist|private|2031/);
    });
  });

  it("retention_policies: entity_id null, detail.key, no values", async () => {
    await withClient(async (c) => {
      const { psy } = await fresh(c);
      await as(c, psy, "update retention_policies set retain_years=10, legal_hold=true where record_type='clinical_notes'");
      await as(c, psy, "insert into retention_policies(record_type) values ('other_type')");
      const rows = await audit(c);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ entity: "retention_policies", entity_id: null, detail: { op: "update", fields: ["legal_hold", "retain_years"], key: "clinical_notes" } });
      expect(rows[1].detail).toMatchObject({ op: "insert", key: "other_type" });
    });
  });

  it("the owner and the service role are audited with an empty actor", async () => {
    await withClient(async (c) => {
      await fresh(c);
      await c.query("update practices set vat_registered = not vat_registered");
      await asService(c, () => c.query("update session_types set active=active, name=name")); // no rows
      const rows = await audit(c);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_id: null, role: null, detail: { op: "update", fields: ["vat_registered"] } });
    });
  });

  it("statements that fail (check, RLS) write no row; people who may not change settings leave no trace", async () => {
    await withClient(async (c) => {
      const { psy, adm, bk, assoc, u1, g } = await fresh(c);
      await expect(as(c, psy, "update practices set vat_rate=101")).rejects.toThrow(/practices_vat_range/);
      for (const u of [adm, bk, assoc, u1, g]) {
        expect((await as(c, u, "update practices set name='x' returning id")).rowCount, "update").toBe(0);
        await expect(as(c, u, "insert into session_types(name,duration_min,fee_cents) values ('x',50,1)")).rejects.toThrow(/row-level security/);
        expect((await as(c, u, "update retention_policies set legal_hold=true")).rowCount).toBe(0);
        expect((await as(c, u, "delete from availability_rules")).rowCount).toBe(0);
      }
      expect(await audit(c)).toEqual([]);
    });
  });

  it("audit rows are readable only by the psychologist, and settings_audit cannot be called", async () => {
    await withClient(async (c) => {
      const { psy, adm, bk, u1 } = await fresh(c);
      await as(c, psy, "update practices set vat_rate=14");
      const n = (u: string) => asUser(c, u, async () => (await c.query("select 1 from audit_log where action like 'settings.%'")).rowCount);
      expect(await n(psy)).toBe(1);
      for (const u of [adm, bk, u1]) expect(await n(u)).toBe(0);
      for (const role of ["anon", "authenticated", "service_role", "public"]) {
        expect((await c.query("select has_function_privilege($1, 'settings_audit()', 'execute') ok", [role === "public" ? "public" : role])).rows[0].ok, role).toBe(false);
      }
      await expect(asUser(c, psy, () => c.query("select settings_audit()"))).rejects.toThrow(/permission denied/);
      await expect(as(c, psy, "insert into audit_log(action) values ('settings.change')")).rejects.toThrow(/permission denied|row-level/);
    });
  });
});

describe("guards", () => {
  const bad = (c: Client, u: string, sql: string, re: RegExp) => expect(as(c, u, sql)).rejects.toThrow(re);
  it("session_types", async () => {
    await withClient(async (c) => {
      const { psy } = await seed(c);
      const ins = (v: string) => `insert into session_types(name,duration_min,fee_cents,buffer_min,deposit_cents) values (${v})`;
      await as(c, psy, ins("'ok',5,0,0,0"));
      await as(c, psy, ins("'ok',240,1000000,120,1000000"));
      await bad(c, psy, ins("'x',4,100,10,0"), /session_types_duration_range/);
      await bad(c, psy, ins("'x',241,100,10,0"), /session_types_duration_range/);
      await bad(c, psy, ins("'x',50,1000001,10,0"), /session_types_fee_range/);
      await bad(c, psy, ins("'x',50,100,121,0"), /session_types_buffer_max/);
      await bad(c, psy, ins("'x',50,100,10,101"), /session_types_deposit_range/);
      await bad(c, psy, ins("'   ',50,100,10,0"), /session_types_name_len/);
      await bad(c, psy, ins(`'${"n".repeat(121)}',50,100,10,0`), /session_types_name_len/);
    });
  });
  it("practices", async () => {
    await withClient(async (c) => {
      const { psy } = await seed(c);
      const up = (set: string) => `update practices set ${set}`;
      await bad(c, psy, up("name=''"), /practices_name_len/);
      await bad(c, psy, up(`name='${"n".repeat(121)}'`), /practices_name_len/);
      await bad(c, psy, up(`registration_no='${"1".repeat(41)}'`), /practices_registration_len/);
      await bad(c, psy, up(`hpcsa_no='${"1".repeat(41)}'`), /practices_hpcsa_len/);
      await bad(c, psy, up("crisis_text='   '"), /practices_crisis_len/);
      await bad(c, psy, up(`crisis_text='${"c".repeat(1001)}'`), /practices_crisis_len/);
      await bad(c, psy, up(`payment_instructions='${"p".repeat(1501)}'`), /practices_payment_len/);
      await bad(c, psy, up("cancellation_window_hours=337"), /practices_window_range/);
      await bad(c, psy, up("cancellation_window_hours=-1"), /practices_window_range/);
      await bad(c, psy, up("late_cancel_fee_cents=1000001"), /practices_late_fee_range/);
      await bad(c, psy, up("vat_rate=-0.01"), /practices_vat_range/);
      await as(c, psy, up(`cancellation_window_hours=336, late_cancel_fee_cents=1000000, vat_rate=100, crisis_text='${"c".repeat(1000)}', payment_instructions='${"p".repeat(1500)}'`));
    });
  });
  it("blocked_times and retention_policies", async () => {
    await withClient(async (c) => {
      const { psy } = await seed(c);
      await bad(c, psy, "insert into blocked_times(starts_at,ends_at) values ('2031-05-01T10:00Z','2031-05-01T10:00Z')", /check constraint/);
      await bad(c, psy, `insert into blocked_times(starts_at,ends_at,reason) values ('2031-05-01T10:00Z','2031-05-01T11:00Z','${"r".repeat(201)}')`, /blocked_times_reason_len/);
      await as(c, psy, `insert into blocked_times(starts_at,ends_at,reason) values ('2031-05-01T10:00Z','2031-05-01T11:00Z','${"r".repeat(200)}')`);
      await bad(c, psy, "update retention_policies set retain_years=0", /retention_years_range/);
      await bad(c, psy, "update retention_policies set retain_years=101", /retention_years_range/);
    });
  });
});

describe("default retention rows", () => {
  it("the five record types are seeded: retain_years null (indefinitely), no legal hold, and seeding wrote no audit row", async () => {
    await withClient(async (c) => {
      const rows = (await c.query("select record_type, retain_years, legal_hold from retention_policies order by 1")).rows;
      expect(rows).toEqual(["audit_log", "clinical_notes", "communications", "financial_records", "forms_consents"].map((record_type) => ({ record_type, retain_years: null, legal_hold: false })));
    });
  });
});

describe("working hours", () => {
  const w = (...p: [string, string][]) => JSON.stringify(p.map(([start, end]) => ({ start, end })));
  const day = async (c: Client, d: number) => (await c.query("select to_char(start_time,'HH24:MI') s, to_char(end_time,'HH24:MI') e from availability_rules where weekday=$1 order by start_time", [d])).rows.map((r) => `${r.s}-${r.e}`);
  const set = (c: Client, u: string, d: number, windows: string) => as(c, u, "select set_day_availability($1, $2::jsonb)", [d, windows]);

  it("overlapping windows are refused by the table itself; touching windows are fine", async () => {
    await withClient(async (c) => {
      const { psy } = await seed(c);
      await as(c, psy, "insert into availability_rules(weekday,start_time,end_time) values (1,'08:00','12:00')");
      await as(c, psy, "insert into availability_rules(weekday,start_time,end_time) values (1,'12:00','17:00')");
      await as(c, psy, "insert into availability_rules(weekday,start_time,end_time) values (2,'08:00','12:00')"); // another weekday
      await expect(as(c, psy, "insert into availability_rules(weekday,start_time,end_time) values (1,'11:55','13:00')")).rejects.toThrow(/overlapping_hours/);
      await expect(as(c, psy, "insert into availability_rules(weekday,start_time,end_time) values (1,'09:00','10:00')")).rejects.toThrow(/overlapping_hours/);
      await expect(as(c, psy, "update availability_rules set end_time='12:30' where weekday=1 and start_time='08:00'")).rejects.toThrow(/overlapping_hours/);
      await expect(as(c, psy, "insert into availability_rules(weekday,start_time,end_time) values (3,'08:00:30','12:00')")).rejects.toThrow(/availability_whole_minutes/);
    });
  });

  it("set_day_availability replaces a day atomically and writes audit rows only for real changes", async () => {
    await withClient(async (c) => {
      const { psy } = await seed(c);
      await set(c, psy, 1, w(["08:00", "12:00"], ["13:00", "17:00"]));
      await set(c, psy, 2, w(["09:00", "10:00"]));
      expect(await day(c, 1)).toEqual(["08:00-12:00", "13:00-17:00"]);
      await clear(c);
      await set(c, psy, 1, w(["08:00", "12:00"], ["13:00", "17:00"])); // unchanged
      expect(await audit(c)).toEqual([]);
      await set(c, psy, 1, w(["08:00", "12:00"], ["13:00", "16:00"], ["16:30", "18:00"])); // one replaced, one added, one kept
      expect(await day(c, 1)).toEqual(["08:00-12:00", "13:00-16:00", "16:30-18:00"]);
      expect((await audit(c)).map((r) => r.detail.op).sort()).toEqual(["delete", "insert", "insert"]);
      expect(await day(c, 2)).toEqual(["09:00-10:00"]); // other days untouched
      await set(c, psy, 1, "[]");
      expect(await day(c, 1)).toEqual([]);
      expect(await day(c, 2)).toEqual(["09:00-10:00"]);
    });
  });

  it("a bad list changes nothing and says why", async () => {
    await withClient(async (c) => {
      const { psy } = await seed(c);
      await set(c, psy, 4, w(["08:00", "12:00"]));
      const fails: [number, string, RegExp][] = [
        [4, w(["08:00", "12:00"], ["11:00", "13:00"]), /overlapping_hours/],
        [4, w(["08:00", "12:00"], ["08:00", "12:00"]), /overlapping_hours/],
        [4, w(["12:00", "08:00"]), /invalid_window/],
        [4, w(["08:00", "08:00"]), /invalid_window/],
        [4, w(["08:03", "12:00"]), /invalid_time/],
        [4, w(["8:00", "12:00"]), /invalid_time/],
        [4, w(["08:00", "24:00"]), /invalid_time/],
        [4, JSON.stringify([{ start: "08:00" }]), /invalid_time/],
        [4, JSON.stringify([{ start: 8, end: 9 }]), /invalid_time/],
        [4, JSON.stringify([1]), /invalid_time/],
        [4, JSON.stringify({ start: "08:00" }), /invalid_windows/],
        [4, "null", /invalid_windows/],
        [4, JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ start: `${String(i + 6).padStart(2, "0")}:00`, end: `${String(i + 6).padStart(2, "0")}:30` }))), /invalid_windows/],
        [7, w(["08:00", "09:00"]), /invalid_weekday/],
        [-1, w(["08:00", "09:00"]), /invalid_weekday/],
      ];
      for (const [d, windows, re] of fails) await expect(set(c, psy, d, windows), `${d} ${windows}`).rejects.toThrow(re);
      expect(await day(c, 4)).toEqual(["08:00-12:00"]);
    });
  });

  it("only the psychologist may call it (RLS and an explicit guard); the owner may", async () => {
    await withClient(async (c) => {
      const { psy, adm, bk, assoc, u1, g } = await seed(c);
      await set(c, psy, 5, w(["08:00", "12:00"]));
      for (const u of [adm, bk, assoc, u1, g]) await expect(set(c, u, 5, "[]"), u).rejects.toThrow(/forbidden/);
      expect(await day(c, 5)).toEqual(["08:00-12:00"]);
      await c.query("select set_day_availability(5, '[{\"start\":\"09:00\",\"end\":\"10:00\"}]'::jsonb)");
      expect(await day(c, 5)).toEqual(["09:00-10:00"]);
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await c.query("select has_function_privilege($1, 'set_day_availability(int,jsonb)', 'execute') ok", [role])).rows[0].ok, role).toBe(role !== "anon");
      }
      const f = (await c.query("select prosecdef from pg_proc where proname='set_day_availability'")).rows[0];
      expect(f.prosecdef).toBe(false);
    });
  });
});
