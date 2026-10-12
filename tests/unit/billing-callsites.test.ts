import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// R34 tripwire: every rpc() the billing actions make must send exactly the parameter names the SQL function declares
// (a renamed or added parameter breaks a PostgREST call at run time, which no type check sees).
const root = join(__dirname, "..", "..");
const migrations = join(root, "supabase", "migrations");
const sql = readdirSync(migrations).sort().map((f) => readFileSync(join(migrations, f), "utf8")).join("\n");
const actions = readFileSync(join(root, "app", "app", "billing", "actions.ts"), "utf8");

/** parameter names of the LAST definition of a function (create function / create or replace function) */
function sqlParams(fn: string): string[] {
  const defs = [...sql.matchAll(new RegExp("create (?:or replace )?function " + fn + "[(]([\\s\\S]*?)[)]\\s*returns", "g"))];
  if (defs.length === 0) throw new Error(`no SQL function ${fn}`);
  return defs[defs.length - 1][1].split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
}
/** the p_* keys of the object the action passes to rpc("fn", {...}) */
function sentKeys(fn: string): string[] {
  const start = actions.indexOf(`rpc("${fn}", {`);
  if (start < 0) throw new Error(`no rpc(${fn}) in actions.ts`);
  const body = actions.slice(start, actions.indexOf("});", start));
  return [...body.matchAll(/\b(p_[a-z_]+)\s*:/g)].map((x) => x[1]);
}

describe("billing rpc call sites match the SQL signatures", () => {
  for (const fn of ["record_payment", "create_invoice_draft", "save_invoice_draft"]) {
    it(fn, () => {
      const declared = sqlParams(fn);
      const sent = sentKeys(fn);
      expect(sent.length).toBeGreaterThan(3);
      expect([...sent].sort()).toEqual([...declared].sort());
    });
  }
  it("record_payment is called by the user path with a manual method only, never payfast / medical_aid", () => {
    expect(actions).not.toMatch(/p_method:\s*["'](payfast|medical_aid)/);
  });
  it("the billing actions never write payments or invoice lines directly and never create a late_cancel_fee task", () => {
    expect(actions).not.toMatch(/from\("payments"\)\.(insert|update|delete)/);
    expect(actions).not.toMatch(/from\("invoice_lines"\)\.(insert|update|delete)/);
    expect(actions).not.toMatch(/from\("tasks"\)/);
  });
});
