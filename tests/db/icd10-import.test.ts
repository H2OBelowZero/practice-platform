import { it, expect } from "vitest";
import type { Client } from "pg";
import { asService, asUser, mkUser, withClient } from "./helpers";

// 0034: the ICD-10 list is loaded by scripts/import-icd10.mjs through import_icd10_codes, with the service key only.

const run = (c: Client, codes: unknown) => asService(c, async () => (await c.query("select * from import_icd10_codes($1::jsonb)", [JSON.stringify(codes)])).rows[0]);

it("the service role imports a batch: new codes inserted, changed descriptions updated, the rest unchanged; counts are audited", () => withClient(async (c) => {
  const r = await run(c, [
    { code: "f32.0", description: " Mild depressive episode " },
    { code: "F41.1", description: "Generalised anxiety disorder" }, // already seeded, same text
    { code: "F43.2", description: "Adjustment disorders (updated wording)" }, // seeded, new text
    { code: "M54.56", description: "Low back pain, lumbar region" },
    { code: "Z63", description: "Problems related to primary support group" },
  ]);
  expect(r).toEqual({ inserted: 3, updated: 1, unchanged: 1 });
  expect((await c.query("select description from icd10_codes where code='F32.0'")).rows[0].description).toBe("Mild depressive episode");
  expect((await c.query("select description from icd10_codes where code='F43.2'")).rows[0].description).toBe("Adjustment disorders (updated wording)");
  const audit = (await c.query("select actor_id, detail from audit_log where action='icd10.import'")).rows;
  expect(audit).toEqual([{ actor_id: null, detail: { received: 5, inserted: 3, updated: 1 } }]);
  expect(await run(c, [{ code: "F32.0", description: "Mild depressive episode" }])).toEqual({ inserted: 0, updated: 0, unchanged: 1 }); // replay is a no-op
}));

it("one bad element rejects the whole batch and writes nothing", () => withClient(async (c) => {
  const before = (await c.query("select count(*)::int n from icd10_codes")).rows[0].n;
  const good = { code: "F32.1", description: "Moderate depressive episode" };
  for (const [codes, err] of [
    [[good, { code: "F3", description: "x" }], /invalid_code: F3/],
    [[good, { code: "32.1", description: "x" }], /invalid_code/],
    [[good, { code: "F32.123", description: "x" }], /invalid_code/],
    [[good, { code: "F32.2", description: "   " }], /invalid_description: F32.2/],
    [[good, { code: "F32.2", description: "x".repeat(501) }], /invalid_description/],
    [[good, { code: "f32.1", description: "again" }], /duplicate_code: F32.1/],
    [[good, { code: 5, description: "x" }], /invalid_batch/],
    [[], /invalid_batch/],
    [{ code: "F32.1" }, /invalid_batch/],
    [Array.from({ length: 1001 }, (_, i) => ({ code: `A${String(i % 100).padStart(2, "0")}.${i % 10}`, description: "x" })), /invalid_batch/],
  ] as const) await expect(run(c, codes), JSON.stringify(codes).slice(0, 60)).rejects.toThrow(err);
  expect((await c.query("select count(*)::int n from icd10_codes")).rows[0].n).toBe(before);
}));

it("nobody but the service role may call it, the psychologist included; the table stays closed to direct writes", () => withClient(async (c) => {
  const psy = await mkUser(c, "psychologist");
  await expect(asUser(c, psy, () => c.query("select * from import_icd10_codes('[{\"code\":\"F32.1\",\"description\":\"x\"}]'::jsonb)"))).rejects.toThrow(/permission denied for function import_icd10_codes/);
  await expect(asService(c, () => c.query("insert into icd10_codes values ('F32.1','x')"))).rejects.toThrow(/permission denied/);
  await c.query("set local role anon");
  try { await expect(c.query("select * from import_icd10_codes('[]'::jsonb)")).rejects.toThrow(/permission denied/); }
  finally { await c.query("reset role"); }
}));
