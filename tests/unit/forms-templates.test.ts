import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DRAFT_LINE, RESTRICTED_KEYS, TEMPLATES } from "@/lib/forms/templates";
import { latestPerKey } from "@/lib/forms/access";
import { buildSeedSql, buildTemplatesBlock, extractTemplatesBlock, replaceTemplatesBlock } from "@/lib/forms/seed-sql";
import { CONSENT_PURPOSES, checkSchema, validateAnswers } from "@/lib/forms/validate";

const root = join(__dirname, "..", "..");
const seedPath = join(root, "supabase", "seed.sql");
const lf = (s: string) => s.replace(/\r\n/g, "\n");

describe("seeded form templates", () => {
  it("covers the nine version 1 templates, version 2 of registration and guardian_info, and the restricted presenting_concerns (final review I5)", () => {
    expect(TEMPLATES.map((t) => `${t.key}@${t.version}`)).toEqual(["registration@1", "medical_history@1", "informed_consent@1", "privacy_notice@1", "telehealth_consent@1", "financial_terms@1", "guardian_info@1", "share_with_referrer@1", "share_with_insurer@1", "registration@2", "guardian_info@2", "presenting_concerns@1"]);
    expect(new Set(TEMPLATES.map((t) => `${t.key}@${t.version}`)).size).toBe(TEMPLATES.length);
  });

  it("clinical questions live only in restricted templates: the newest version of every admin-readable form asks none of them", () => {
    const clinical = ["reason_for_visit", "court_orders", "child_concerns"];
    const newest = latestPerKey(TEMPLATES);
    for (const t of newest.filter((x) => x.schema.restricted !== true)) for (const k of clinical) expect(t.schema.fields.map((f) => f.key), `${t.key}@${t.version}`).not.toContain(k);
    const pc = newest.find((t) => t.key === "presenting_concerns")!;
    expect(pc.schema.restricted).toBe(true);
    expect(pc.schema.fields.map((f) => f.key)).toEqual(["reason_for_visit", "child_concerns", "court_orders"]);
    expect(RESTRICTED_KEYS).toContain("presenting_concerns");
    // version 1 is history: unchanged, still holding the old fields (submissions record the version they answered)
    expect(TEMPLATES.find((t) => t.key === "registration" && t.version === 1)!.schema.fields.map((f) => f.key)).toContain("reason_for_visit");
    expect(TEMPLATES.find((t) => t.key === "guardian_info" && t.version === 1)!.schema.fields.map((f) => f.key)).toEqual(expect.arrayContaining(["court_orders", "child_concerns"]));
    // version 2 keeps every other question of version 1, in order
    for (const key of ["registration", "guardian_info"]) {
      const [v1, v2] = [1, 2].map((v) => TEMPLATES.find((t) => t.key === key && t.version === v)!.schema.fields.map((f) => f.key));
      expect(v2, key).toEqual(v1.filter((k) => !clinical.includes(k)));
    }
  });

  it.each(TEMPLATES.map((t) => [`${t.key}@${t.version}`, t] as const))("%s passes the structural check", (_k, t) => expect(checkSchema(t.schema)).toEqual([]));

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
    for (const k of ["registration", "medical_history", "guardian_info", "presenting_concerns"]) expect(purposeOf(k)).toBeUndefined();
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

describe("database form errors in plain language (0033 required fields)", () => {
  it("a required or malformed answer refused by submit_form gets its own text and never echoes the field key or the raw message", async () => {
    const { formErrorText, FORM_ERROR } = await import("@/lib/forms/errors");
    for (const m of ["required_field_missing: typed_name", "ERROR:  invalid_field_value: contact_preference"]) {
      expect(formErrorText(m)).toBe("Please answer every required question with one of the choices offered, then try again.");
      expect(formErrorText(m)).not.toMatch(/typed_name|contact_preference/);
    }
    expect(formErrorText("consent_required_missing")).toMatch(/consent boxes/); // the consent errors keep theirs
    expect(formErrorText("something else")).toBe(FORM_ERROR.generic);
  });
  it("the staff forms tab tells the admin that both restricted forms are hidden", () => {
    const src = readFileSync(join(root, "app", "app", "patients", "[id]", "tab-forms.tsx"), "utf8");
    expect(src).toContain("The health history and &quot;What brings you to therapy&quot; forms are visible to the psychologist only.");
    expect(src).toContain("!(admin && t.schema?.restricted === true)");
  });
});
