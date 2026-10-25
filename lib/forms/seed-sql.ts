import { TEMPLATES } from "./templates";

export const SEED_HEADER = [
  "-- supabase/seed.sql",
  "-- FICTIONAL / DRAFT WORDING — to be reviewed by the practice and a legal advisor before live use",
  "-- Safe on every project (no accounts, no personal data), but the wording is a DRAFT: do not use it with real patients until it has been reviewed.",
  "-- Demo accounts and data are NOT in this file: they are in supabase/seed-demo.sql, which is never run automatically.",
  "-- The form templates between the BEGIN/END markers are GENERATED from lib/forms/templates.ts: edit that file, then run",
  "-- `UPDATE_SEED=1 npm run test:unit` (tests/unit/forms-templates.test.ts). Anything outside the markers is left alone.",
  "-- Every published version of each intake form and consent (older versions stay for history). Safe to run more than once (existing key + version rows are left alone).",
  "",
].join("\n");

export const BEGIN = "-- BEGIN generated form templates";
export const END = "-- END generated form templates";

/** The generated region of supabase/seed.sql, markers included. Dollar-quoted JSON, so no escaping can go wrong. */
export function buildTemplatesBlock(): string {
  const rows = TEMPLATES.map((t) => {
    const json = JSON.stringify(t.schema, null, 2);
    if (json.includes("$tpl$")) throw new Error(`template ${t.key} contains the dollar-quote tag`);
    return `insert into form_templates(key, version, schema) values ('${t.key}', ${t.version}, $tpl$${json}$tpl$::jsonb)\non conflict (key, version) do nothing;\n`;
  });
  return `${BEGIN}\n${rows.join("\n")}${END}\n`;
}

/** The whole file for a fresh seed. */
export const buildSeedSql = (): string => `${SEED_HEADER}\n${buildTemplatesBlock()}`;

/** Replace the generated region of an existing seed file (everything outside the markers is kept). Null when the markers are missing. */
export function replaceTemplatesBlock(existing: string): string | null {
  const a = existing.indexOf(BEGIN), b = existing.indexOf(END);
  if (a < 0 || b < a) return null;
  return existing.slice(0, a) + buildTemplatesBlock() + existing.slice(b + END.length).replace(/^\n/, "");
}

/** The generated region as found in an existing file. */
export function extractTemplatesBlock(existing: string): string | null {
  const a = existing.indexOf(BEGIN), b = existing.indexOf(END);
  return a < 0 || b < a ? null : existing.slice(a, b + END.length) + "\n";
}
