import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withClient } from "./helpers";
import { checkSchema } from "@/lib/forms/validate";

const seedSql = readFileSync(join(__dirname, "..", "..", "supabase", "seed.sql"), "utf8");

it("seed.sql loads, is safe to run twice, and stores nine valid version 1 templates", () => withClient(async (c) => {
  await c.query(seedSql);
  await c.query(seedSql); // on conflict do nothing
  const { rows } = await c.query("select key, version, schema, active from form_templates order by key");
  expect(rows.map((r) => r.key)).toEqual(["financial_terms", "guardian_info", "informed_consent", "medical_history", "privacy_notice", "registration", "share_with_insurer", "share_with_referrer", "telehealth_consent"]);
  for (const r of rows) {
    expect(r.version).toBe(1);
    expect(r.active).toBe(true);
    expect(checkSchema(r.schema), r.key).toEqual([]);
  }
}));

it("only the health history is restricted (admin cannot read its submissions)", () => withClient(async (c) => {
  await c.query(seedSql);
  const { rows } = await c.query("select key from form_templates where schema ->> 'restricted' = 'true'");
  expect(rows.map((r) => r.key)).toEqual(["medical_history"]);
}));
