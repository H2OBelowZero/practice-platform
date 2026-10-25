import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withClient } from "./helpers";
import { checkSchema } from "@/lib/forms/validate";

const seedSql = readFileSync(join(__dirname, "..", "..", "supabase", "seed.sql"), "utf8");

it("seed.sql loads, is safe to run twice, and stores every template version, all valid and active", () => withClient(async (c) => {
  await c.query(seedSql);
  await c.query(seedSql); // on conflict do nothing
  const { rows } = await c.query("select key, version, schema, active from form_templates order by key, version");
  expect(rows.map((r) => `${r.key}@${r.version}`)).toEqual(["financial_terms@1", "guardian_info@1", "guardian_info@2", "informed_consent@1", "medical_history@1",
    "presenting_concerns@1", "privacy_notice@1", "registration@1", "registration@2", "share_with_insurer@1", "share_with_referrer@1", "telehealth_consent@1"]);
  for (const r of rows) {
    expect(r.active).toBe(true);
    expect(checkSchema(r.schema), r.key).toEqual([]);
  }
}));

it("only the health history and presenting concerns are restricted (admin cannot read their submissions)", () => withClient(async (c) => {
  await c.query(seedSql);
  const { rows } = await c.query("select distinct key from form_templates where schema ->> 'restricted' = 'true' order by key");
  expect(rows.map((r) => r.key)).toEqual(["medical_history", "presenting_concerns"]);
}));
