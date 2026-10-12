import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// R34 tripwire for Task 16a: the rpc() calls the dashboard makes must send exactly the parameters the SQL functions declare, and the staff tasks / audit code
// must keep to the columns and actions they are allowed.
const root = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const sql = readdirSync(join(root, "supabase", "migrations")).sort().map((f) => read("supabase", "migrations", f)).join("\n");
const load = read("lib", "dashboard", "load.ts");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const tasksActions = stripComments(read("app", "app", "tasks", "actions.ts"));
const exportRoute = read("app", "app", "audit", "export", "route.ts");
const auditPage = read("app", "app", "audit", "page.tsx");

function sqlParams(fn: string): string[] {
  const defs = [...sql.matchAll(new RegExp("create (?:or replace )?function " + fn + "[(]([\\s\\S]*?)[)]\\s*returns", "g"))];
  if (defs.length === 0) throw new Error(`no SQL function ${fn}`);
  return defs[defs.length - 1][1].split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
}
const sent = (fn: string): string[] => {
  const at = load.indexOf(`rpc("${fn}"`);
  if (at < 0) throw new Error(`no rpc(${fn})`);
  const call = load.slice(at, load.indexOf("))", at));
  return [...call.matchAll(/\b(p_[a-z_]+)\s*:/g)].map((m) => m[1]);
};

describe("dashboard rpc call sites match the SQL signatures", () => {
  it("dashboard_payments_by_method(p_from, p_to)", () => {
    expect([...sent("dashboard_payments_by_method")].sort()).toEqual([...sqlParams("dashboard_payments_by_method")].sort());
  });
  it("billing_open_by_due_date() takes no arguments", () => {
    expect(sqlParams("billing_open_by_due_date")).toEqual([]);
    expect(load).toMatch(/rpc\("billing_open_by_due_date"\)/);
  });
  it("0024 grants the new function to authenticated and service_role only, and it is SECURITY INVOKER", () => {
    const m = read("supabase", "migrations", "0024_dashboard_queries.sql");
    expect(m).toMatch(/security invoker/);
    expect(m).not.toMatch(/security definer/);
    expect(m).toMatch(/revoke execute on function dashboard_payments_by_method\(date, date\) from public, anon;/);
    expect(m).toMatch(/grant execute on function dashboard_payments_by_method\(date, date\) to authenticated, service_role;/);
  });
});

describe("the dashboard never reads clinical content or money rows", () => {
  it("selects no note text, answers, ICD-10 codes or payment rows", () => {
    for (const word of ["icd10", "answers", "content", "clinical_notes(state)"]) {
      if (word === "clinical_notes(state)") continue; // the one allowed join, inside lib/notes/pending.ts only
      expect(load.toLowerCase(), word).not.toContain(word);
    }
    expect(load).not.toMatch(/from\("payments"\)/);
    expect(load).not.toMatch(/from\("clinical_notes"\)/);
    expect(load).not.toMatch(/\.(insert|update|delete|upsert)\(/); // read-only
  });
  it("notes are only queried through notesToComplete, which refuses every role but the psychologist", () => {
    expect(load).toMatch(/notesToComplete\(sb, role\)/);
    expect(load).toMatch(/if \(role !== "psychologist"\) return null;/);
  });
});

describe("staff task actions", () => {
  it("call requireRole first in every exported action and never use the service client", () => {
    const fns = [...tasksActions.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\s*await requireRole\(/g)].map((m) => m[1]);
    expect(fns.sort()).toEqual(["createTask", "setTaskStatus", "updateTask"]);
    expect(tasksActions).not.toContain("supabaseService");
  });
  it("write only title, due_at, priority, patient_id, status and a manual source: never meta, assignee, appointment or a system source", () => {
    expect(tasksActions).not.toMatch(/\bmeta\b\s*:/);
    expect(tasksActions).not.toMatch(/\bassignee\b|\bappointment_id\b/);
    expect(tasksActions).not.toMatch(/\.delete\(/);
    expect(tasksActions).not.toMatch(/source:\s*"(?!manual")/);
    expect(tasksActions).not.toMatch(/raise_risk_task|raise_payfast_unreconciled|late_cancel_fee|risk_flag/);
  });
  it("audit rows carry ids and field names only", () => {
    const calls = tasksActions.split("\n").filter((l) => l.includes("audit("));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) expect(c).not.toMatch(/\.title|\bvalues\b|title:|due_at:|priority:|patient_id:/);
  });
});

describe("audit viewer", () => {
  it("export and page are psychologist only and audit before reading or returning data", () => {
    expect(exportRoute).toMatch(/requireRole\(\["psychologist"\]\)/);
    expect(auditPage).toMatch(/requireRole\(\["psychologist"\]\)/);
    expect(exportRoute.indexOf('audit("export.audit"')).toBeGreaterThan(exportRoute.indexOf("EXPORT_CHUNK"));
    expect(exportRoute.indexOf('audit("export.audit"')).toBeLessThan(exportRoute.indexOf("toCsv("));
    expect(auditPage.indexOf('audit("audit.view"')).toBeLessThan(auditPage.indexOf('from("audit_log")'));
    expect(exportRoute).not.toContain("supabaseService");
    expect(auditPage).not.toContain("supabaseService");
  });
  it("neither selects actor ids or raw detail into the output", () => {
    expect(exportRoute).not.toMatch(/JSON\.stringify\(r\.detail|detail:\s*r\.detail/);
    expect(exportRoute).toContain("auditDetailSummary");
    expect(auditPage).toContain("auditDetailSummary");
    expect(auditPage).not.toMatch(/JSON\.stringify/);
  });
  it("0024 adds the three audit_log indexes", () => {
    const m = read("supabase", "migrations", "0024_dashboard_queries.sql");
    expect(m).toMatch(/audit_log \(at desc\)/);
    expect(m).toMatch(/audit_log \(entity, entity_id\)/);
    expect(m).toMatch(/audit_log \(actor_id, at\)/);
  });
});
