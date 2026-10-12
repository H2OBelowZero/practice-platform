import { it, expect, describe } from "vitest";
import type { Client } from "pg";
import { withClient, asService } from "./helpers";
import { seed, mkInvoice, as, guardianWith } from "./billing-helpers";

// 0018: credit_notes.reason (staff free text) and created_by are not readable through the table by the Postgres role `authenticated`, which patients,
// guardians and every kind of staff share, so column grants alone cannot separate them. Staff read them through credit_note_details(), which checks
// the caller's application role. The allowed columns stay readable (the portal and invoice_balances need them).
const SAFE = "id, invoice_id, amount_cents, portion, created_at";
const credit = (c: Client, psy: string, i: string, amount = 1000, reason = "private reason") =>
  as(c, psy, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,$2,$3,'patient') returning id", [i, amount, reason]).then((r) => r.rows[0].id as string);
const asAnon = async <T>(c: Client, fn: () => Promise<T>) => {
  await c.query("set local role anon");
  try { return await fn(); } finally { await c.query("reset role"); }
};

describe("column privileges", () => {
  it("nobody but the owner can read reason or created_by from the table, including the psychologist (same Postgres role as patients)", () => withClient(async (c) => {
    const { psy, adm, bk, assoc, u1, g, p1 } = await seed(c);
    const i = await mkInvoice(c, p1);
    await credit(c, psy, i);
    for (const [u, who] of [[psy, "psychologist"], [adm, "admin"], [bk, "bookkeeper"], [assoc, "associate"], [u1, "patient"], [g, "guardian"]] as const) {
      for (const col of ["reason", "created_by"]) await expect(as(c, u, `select ${col} from credit_notes`), `${who} ${col}`).rejects.toThrow(/permission denied/);
      await expect(as(c, u, "select * from credit_notes"), `${who} select *`).rejects.toThrow(/permission denied/);
      await expect(as(c, u, "select id from credit_notes where reason like '%private%'"), `${who} filter by reason`).rejects.toThrow(/permission denied/);
    }
    await expect(asAnon(c, () => c.query("select reason from credit_notes"))).rejects.toThrow(/permission denied/);
    await expect(asAnon(c, () => c.query("select id from credit_notes"))).rejects.toThrow(/permission denied/);
  }));

  it("the portal's columns stay readable, with the same row visibility as before", () => withClient(async (c) => {
    const { psy, bk, u1, u2, g, p1 } = await seed(c);
    const i = await credit(c, psy, await mkInvoice(c, p1));
    const gNo = await guardianWith(c, p1, '{"pay": false}');
    for (const u of [psy, bk, u1, g]) expect((await as(c, u, `select ${SAFE} from credit_notes`)).rows, u).toHaveLength(1);
    for (const u of [u2, gNo]) expect((await as(c, u, `select ${SAFE} from credit_notes`)).rows, u).toHaveLength(0);
    expect(i).toBeTruthy();
    // views and functions that sum credits still work for every reader
    expect((await as(c, u1, "select credit_cents from invoice_balances")).rows[0].credit_cents).toBe(1000);
  }));

  it("the psychologist's INSERT still works, with and without RETURNING of allowed columns; RETURNING reason is refused", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await mkInvoice(c, p1, { total: 100000 });
    await as(c, psy, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,100,'a','patient')", [i]);
    await as(c, psy, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,100,'b','patient') returning id, portion", [i]);
    await expect(as(c, psy, "insert into credit_notes(invoice_id,amount_cents,reason,portion) values ($1,100,'c','patient') returning reason", [i])).rejects.toThrow(/permission denied/);
    expect((await c.query("select count(*)::int n from credit_notes")).rows[0].n).toBe(2);
  }));
});

describe("credit_note_details(invoice)", () => {
  it("psychologist and admin get reason and created_by for that invoice's credit notes only", () => withClient(async (c) => {
    const { psy, adm, p1 } = await seed(c);
    const i = await mkInvoice(c, p1);
    const a = await credit(c, psy, i, 100, "first"), b = await credit(c, psy, i, 200, "second");
    await credit(c, psy, await mkInvoice(c, p1), 300, "another invoice");
    for (const u of [psy, adm]) {
      const r = (await as(c, u, "select id, reason, created_by from credit_note_details($1) order by reason", [i])).rows;
      expect(r, u).toEqual([{ id: a, reason: "first", created_by: psy }, { id: b, reason: "second", created_by: psy }]); // (created_at ties inside one test transaction)
    }
  }));

  it("bookkeeper, associate, patient and guardian are forbidden (R39), even for their own invoice; anon cannot call it", () => withClient(async (c) => {
    const { psy, bk, assoc, u1, u2, g, p1 } = await seed(c);
    const i = await mkInvoice(c, p1);
    await credit(c, psy, i);
    for (const [u, who] of [[bk, "bookkeeper"], [assoc, "associate"], [u1, "patient"], [u2, "other patient"], [g, "guardian"]] as const)
      await expect(as(c, u, "select * from credit_note_details($1)", [i]), who).rejects.toThrow(/forbidden/);
    await expect(asAnon(c, () => c.query("select * from credit_note_details($1)", [i]))).rejects.toThrow(/permission denied/);
    await expect(asService(c, () => c.query("select * from credit_note_details($1)", [i]))).rejects.toThrow(/forbidden/); // no application role
  }));

  it("an invoice without credit notes (or an unknown one) returns no rows", () => withClient(async (c) => {
    const { psy, p1 } = await seed(c);
    const i = await mkInvoice(c, p1);
    expect((await as(c, psy, "select * from credit_note_details($1)", [i])).rows).toEqual([]);
    expect((await as(c, psy, "select * from credit_note_details('00000000-0000-0000-0000-000000000000')")).rows).toEqual([]);
  }));

  it("is SECURITY DEFINER with a pinned search_path and the R4 grants", () => withClient(async (c) => {
    const f = (await c.query("select prosecdef, proconfig from pg_proc where proname='credit_note_details'")).rows[0];
    expect(f.prosecdef).toBe(true);
    expect(f.proconfig).toEqual(expect.arrayContaining(["search_path=public, pg_temp"]));
    const g = (await c.query("select grantee from information_schema.routine_privileges where routine_name='credit_note_details' order by 1")).rows.map((r) => r.grantee);
    expect(g).toEqual(expect.arrayContaining(["authenticated", "service_role"]));
    expect(g).not.toContain("anon");
    expect(g).not.toContain("PUBLIC");
  }));
});
