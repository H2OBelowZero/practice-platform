import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// docs/reference.md, "Where the current definition of each guard and function lives": the table must name, for every function the migrations create,
// the LAST migration file that (re)defines it. Recomputed here from supabase/migrations, so the table cannot silently go stale.
const root = join(__dirname, "..", "..");
const dir = join(root, "supabase", "migrations");

describe("docs/reference.md function table", () => {
  it("lists every function with the migration that holds its current definition", () => {
    const latest = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(dir, f), "utf8").replace(/--.*$/gm, "");
      for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_0-9]+)\s*\(/gi)) latest.set(m[1].toLowerCase(), f.replace(/\.sql$/, ""));
    }
    const doc = readFileSync(join(root, "docs", "reference.md"), "utf8");
    const section = doc.slice(doc.indexOf("## Where the current definition of each guard and function lives"));
    const table = new Map([...section.matchAll(/^\| `([a-z_0-9]+)` \| `([0-9a-z_]+)` \|/gm)].map((m) => [m[1], m[2]]));
    expect(latest.size).toBeGreaterThan(80); // sanity: the scan really found the functions
    expect(Object.fromEntries([...table].sort())).toEqual(Object.fromEntries([...latest].sort()));
    // the redefinitions the final review touched point at the new files
    expect(table.get("auth_role")).toBe("0030_staff_mfa_in_db");
    expect(table.get("patients_guard")).toBe("0031_access_scoping");
    expect(table.get("claims_guard")).toBe("0032_claims_insurer_consent");
    expect(table.get("submit_form")).toBe("0033_submit_form_required_fields");
  });
});
