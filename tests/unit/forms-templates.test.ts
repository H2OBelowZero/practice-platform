import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRAFT_LINE, TEMPLATES } from "@/lib/forms/templates";
import { buildSeedSql, buildTemplatesBlock, extractTemplatesBlock, replaceTemplatesBlock } from "@/lib/forms/seed-sql";
import { CONSENT_PURPOSES, checkSchema, validateAnswers } from "@/lib/forms/validate";

const root = join(__dirname, "..", "..");
const seedPath = join(root, "supabase", "seed.sql");
const lf = (s: string) => s.replace(/\r\n/g, "\n");

describe("seeded form templates", () => {
  it("covers the nine templates, all version 1", () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(["registration", "medical_history", "informed_consent", "privacy_notice", "telehealth_consent", "financial_terms", "guardian_info", "share_with_referrer", "share_with_insurer"]);
    expect(TEMPLATES.every((t) => t.version === 1)).toBe(true);
  });

  it.each(TEMPLATES.map((t) => [t.key, t] as const))("%s passes the structural check", (_k, t) => expect(checkSchema(t.schema)).toEqual([]));

  it("every consentPurpose is one the consents table allows (read from the migration)", () => {
    const dir = join(root, "supabase", "migrations");
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const m = /create table consents[^;]*?purpose text not null check \(purpose in \(([^)]*)\)/.exec(sql);
    expect(m, "consents purpose check not found in migrations").toBeTruthy();
    const db = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect([...CONSENT_PURPOSES].sort()).toEqual([...db].sort());
    for (const t of TEMPLATES) for (const f of t.schema.fields) if (f.consentPurpose) expect(db, `${t.key}.${f.key}`).toContain(f.consentPurpose);
  });

  it("the consent templates carry the purpose the brief names", () => {
    const purposeOf = (key: string) => TEMPLATES.find((t) => t.key === key)!.schema.fields.find((f) => f.consentPurpose)?.consentPurpose;
    expect(purposeOf("informed_consent")).toBe("treatment");
    expect(purposeOf("privacy_notice")).toBe("privacy_notice");
    expect(purposeOf("telehealth_consent")).toBe("telehealth");
    expect(purposeOf("financial_terms")).toBe("financial_terms");
    expect(purposeOf("share_with_referrer")).toBe("share_referrer");
    expect(purposeOf("share_with_insurer")).toBe("share_insurer");
    for (const k of ["registration", "medical_history", "guardian_info"]) expect(purposeOf(k)).toBeUndefined();
  });

  it("every consent, privacy, terms, telehealth and sharing form opens with the visible draft-wording line", () => {
    const consent = TEMPLATES.filter((t) => t.schema.fields.some((f) => f.consentPurpose));
    expect(consent.length).toBe(6);
    for (const t of consent) expect(t.schema.intro?.startsWith(DRAFT_LINE), t.key).toBe(true);
    expect(DRAFT_LINE).toBe("Draft wording — to be reviewed by the practice and a legal advisor before live use.");
  });

  it("an empty submission is refused where fields are required, and a complete one passes (required fields are answerable)", () => {
    for (const t of TEMPLATES) {
      const full: Record<string, unknown> = {};
      for (const f of t.schema.fields) full[f.key] = f.type === "checkbox" ? true : f.type === "select" ? f.options![0] : f.type === "date" ? "2030-01-01" : "text";
      expect(validateAnswers(t.schema, full).ok, t.key).toBe(true);
      const hasRequired = t.schema.fields.some((f) => f.required);
      expect(validateAnswers(t.schema, {}).ok, t.key).toBe(!hasRequired);
    }
  });

  it("supabase/seed.sql carries the draft banner and the generated templates exactly (UPDATE_SEED=1 regenerates)", () => {
    if (process.env.UPDATE_SEED) {
      const next = existsSync(seedPath) ? replaceTemplatesBlock(lf(readFileSync(seedPath, "utf8"))) ?? buildSeedSql() : buildSeedSql();
      writeFileSync(seedPath, next, "utf8");
    }
    const text = lf(readFileSync(seedPath, "utf8"));
    expect(text).toContain("FICTIONAL / DRAFT WORDING — to be reviewed by the practice and a legal advisor before live use");
    expect(extractTemplatesBlock(text), "seed.sql is out of date: run UPDATE_SEED=1 npm run test:unit").toBe(buildTemplatesBlock());
  });
});
