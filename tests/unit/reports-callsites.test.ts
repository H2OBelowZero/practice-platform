import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXPORT_ROLES, type ExportKey } from "@/lib/reports/keys";

// R34 call-site audit for the reports: every database call in the reports code is compared with the SQL it calls (0025), and the tripwires below keep the
// reports away from the service client and from identity columns.
const root = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const sql = read("supabase", "migrations", "0025_reports.sql");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(n) ? [p] : [];
  });
}
const reportsCode = ["app/app/reports", "lib/reports", "components/reports"].flatMap((d) => files(join(root, d)));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code without comments

/** name -> parameter names, from `create function name(p_a date, p_b date)` */
const sqlFns = Object.fromEntries([...sql.matchAll(/create function (\w+)\(([^)]*)\)/g)].map((m) => [m[1], m[2].split(",").map((x) => x.trim().split(/\s+/)[0]).filter(Boolean)]));
/** name -> role guard (the roles after the first `raise exception 'forbidden'` condition of that function) */
function guardOf(fn: string): string[] {
  const body = sql.slice(sql.indexOf(`create function ${fn}(`));
  const line = body.split("\n").find((l) => l.includes("raise exception 'forbidden'")) ?? "";
  const list = /not in \(([^)]*)\)/.exec(line);
  if (list) return [...list[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const one = /<> '(\w+)'/.exec(line);
  return one ? [one[1]] : [];
}

describe("every rpc in lib/reports/queries.ts matches a function in 0025", () => {
  const calls = [...strip(read("lib", "reports", "queries.ts")).matchAll(/rpcRows\(sb, ("[a-z_]+"|fn), (range\(r\)|\{[^}]*\})\)/g)];
  const flatCalls = [...strip(read("lib", "reports", "queries.ts")).matchAll(/flat\(sb, "([a-z_]+)", r\)/g)].map((m) => m[1]);
  const named = calls.filter((m) => m[1] !== "fn").map((m) => ({ fn: m[1].replaceAll('"', ""), args: m[2] === "range(r)" ? ["p_from", "p_to"] : [...m[2].matchAll(/\b(p_\w+)\s*:/g)].map((x) => x[1]) }));
  for (const f of flatCalls) named.push({ fn: f, args: ["p_from", "p_to"] }); // the flat() helper sends range(r)

  it("finds every call (nine functions)", () => {
    expect(named.map((n) => n.fn).sort()).toEqual(Object.keys(sqlFns).sort());
    expect(Object.keys(sqlFns)).toHaveLength(9);
  });
  it("sends exactly the SQL parameter names", () => {
    for (const { fn, args } of named) expect(args, fn).toEqual(sqlFns[fn]);
  });
  it("the flat() helper and range() send p_from and p_to", () => {
    const src = read("lib", "reports", "queries.ts");
    expect(src).toMatch(/const range = \(r: Range\) => \(\{ p_from: r\.from, p_to: r\.to \}\)/);
    expect(src).toMatch(/rpcRows\(sb, fn, range\(r\)\)/);
  });
});

describe("the role matrix in TypeScript is the one in the SQL guards", () => {
  const FIN = ["psychologist", "admin", "bookkeeper"], STAFF = ["psychologist", "admin"];
  it("each report function's guard", () => {
    expect(guardOf("report_income_by_month")).toEqual(FIN);
    expect(guardOf("report_income_by_method")).toEqual(FIN);
    expect(guardOf("report_income_by_session_type")).toEqual(FIN);
    expect(guardOf("report_debtors_detail")).toEqual(FIN);
    expect(guardOf("report_debtors_ageing")).toEqual(FIN);
    expect(guardOf("report_transactions")).toEqual(FIN);
    expect(guardOf("report_appointments")).toEqual(STAFF);
    expect(guardOf("report_practice_activity")).toEqual(STAFF);
    expect(guardOf("report_compliance")).toEqual(["psychologist"]);
  });
  it("export roles agree with the SQL guard of the function each export calls", () => {
    const fnOf: Record<ExportKey, string> = {
      income_by_month: "report_income_by_month", income_by_method: "report_income_by_method", income_by_session_type: "report_income_by_session_type", debtors: "report_debtors_detail",
      appointments: "report_appointments", activity: "report_practice_activity", compliance: "report_compliance", transactions: "report_transactions",
    };
    for (const [key, fn] of Object.entries(fnOf)) expect([...EXPORT_ROLES[key as ExportKey]].sort(), key).toEqual([...guardOf(fn)].sort());
  });
});

describe("tripwires on the reports code", () => {
  it("the service client and the service key are never used (reports run as the signed-in user, under RLS)", () => {
    const bad = reportsCode.filter((f) => /supabaseService|SUPABASE_SERVICE_ROLE|supabase\/service|service_role|createClient\(/.test(strip(readFileSync(f, "utf8"))));
    expect(bad).toEqual([]);
  });
  it("no select(\"*\") anywhere in the reports code, and audit_log is never read directly (the compliance report is a database function)", () => {
    for (const f of reportsCode) {
      const code = strip(readFileSync(f, "utf8"));
      expect(code, f).not.toMatch(/\.select\(\s*["'`]\s*\*/);
      expect(code, f).not.toMatch(/from\(\s*["'`]audit_log/);
    }
  });
  it("patients is read in one place only, for id and names, behind the bookkeeper check", () => {
    const users = reportsCode.filter((f) => /from\(\s*["'`]patients/.test(strip(readFileSync(f, "utf8"))));
    expect(users.map((f) => f.replace(root, "").replaceAll("\\", "/"))).toEqual(["/lib/reports/load.ts"]);
    const load = strip(read("lib", "reports", "load.ts"));
    expect(load).toContain('.select("id, first_name, last_name")');
    expect(load).toContain('role === "bookkeeper" ? []');
    expect(load).toContain('names: role === "bookkeeper" ? null');
  });
  it("the debtors name column is only built for roles other than the bookkeeper", () => {
    const fin = read("components", "reports", "financial.tsx");
    expect(fin).toContain('const canSeeNames = role !== "bookkeeper"');
    expect(fin).toMatch(/\.\.\.\(canSeeNames \? \[\{/);
  });
  it("no report result type carries a patient name, and the CSV code never writes the debtors patient id", () => {
    const exp = strip(read("lib", "reports", "exports.ts"));
    expect(exp).not.toMatch(/patientId|patient_id|first_name|last_name/);
  });
  it("only the reports page and the export route are new routes; the export route requires a role itself", () => {
    expect(read("app", "app", "reports", "page.tsx")).toContain("requireRole(REPORT_ROLES)");
    expect(read("app", "app", "reports", "export", "route.ts")).toContain("requireRole(REPORT_ROLES)");
    expect(files(join(root, "app", "app", "reports")).map((f) => f.replace(root, "").replaceAll("\\", "/")).sort()).toEqual(["/app/app/reports/export/route.ts", "/app/app/reports/page.tsx"]);
  });
  it("every CSV control is an AnchorButton (plain anchor), never a Link", () => {
    const ui = read("components", "reports", "ui.tsx"), fin = read("components", "reports", "financial.tsx");
    expect(ui).toMatch(/<AnchorButton[^>]*href=\{exportHref\}/);
    expect(fin).toMatch(/<AnchorButton href=\{exportHref\("transactions", period\)\}/);
    for (const f of ["ui.tsx", "financial.tsx", "practice.tsx", "controls.tsx"]) expect([...read("components", "reports", f).matchAll(/<Link\b[^>]*>/g)].filter((m) => /export/i.test(m[0]))).toEqual([]);
  });
  it("the export route audits before returning data and refuses when the audit fails", () => {
    const route = strip(read("app", "app", "reports", "export", "route.ts"));
    expect(route.indexOf('audit("export.report"')).toBeGreaterThan(route.indexOf("exportRows("));
    expect(route.indexOf('audit("export.report"')).toBeLessThan(route.indexOf("new Response(`${toCsv("));
    expect(route).toContain("Cache-Control");
    expect(route).toContain("X-Content-Type-Options");
    expect(route).toMatch(/isPrefetch\(req\.headers\)\) return new Response\(null, \{ status: 204/);
  });
});

describe("report_compliance only counts audit actions that something writes", () => {
  // Task 16c's settings audit triggers will write settings.* / practice.* actions; until then those two families legitimately count zero.
  const NOT_WRITTEN_YET = ["settings.%", "practice.%"];
  const body = sql.slice(sql.indexOf("create function report_compliance("), sql.indexOf("create function report_transactions("));
  const counted = [...new Set([...body.matchAll(/l\.action (?:= |like )'([a-z_.%]+)'/g)].map((m) => m[1]))];
  const writers = [
    ...readdirSync(join(root, "supabase", "migrations")).filter((f) => f !== "0025_reports.sql" && f.endsWith(".sql")).map((f) => read("supabase", "migrations", f)),
    ...["app", "lib"].flatMap((d) => files(join(root, d))).map((f) => strip(readFileSync(f, "utf8"))),
  ].join("\n");

  it("lists the actions the SQL counts (so a new one is a deliberate change)", () => {
    expect(counted.sort()).toEqual(["auth.login", "claim.view", "consent.grant", "consent.withdraw", "export.%", "note.addendum", "note.view", "patient.view", "payfast.itn.rejected", "practice.%", "settings.%"]);
  });
  it("every counted action, except the allow-listed families, is written somewhere in the migrations or the app", () => {
    const missing = counted.filter((a) => !NOT_WRITTEN_YET.includes(a)).filter((a) => {
      if (a === "consent.grant" || a === "consent.withdraw") return !/'consent\.'\s*\|\|\s*case when p_granted then 'grant' else 'withdraw' end/.test(writers); // _set_consent_core builds the name
      if (a.endsWith(".%")) return !new RegExp("[\"'`]" + a.slice(0, -1).replace(".", "\\.") + "[a-z_]+[\"'`]").test(writers);
      return !new RegExp("[\"']" + a.replace(".", "\\.") + "[\"']").test(writers);
    });
    expect(missing).toEqual([]);
  });
  it("the allow-listed families have NO writer yet: when Task 16c adds one this fails, and the allow-list entry must then be removed so the first test covers it", () => {
    expect(NOT_WRITTEN_YET).toEqual(["settings.%", "practice.%"]);
    expect(counted).toEqual(expect.arrayContaining(NOT_WRITTEN_YET));
    for (const family of NOT_WRITTEN_YET) {
      const prefix = family.slice(0, -1).replace(".", "\\.");
      expect(new RegExp("[\"'`]" + prefix + "[a-z_]+[\"'`]").test(writers), family + " now has a writer: remove it from NOT_WRITTEN_YET").toBe(false);
    }
  });
});

describe("0025 itself", () => {
  it("is invoker except for the one documented definer, with a pinned search_path and R4 grants for every function", () => {
    for (const fn of Object.keys(sqlFns)) {
      const head = sql.slice(sql.indexOf(`create function ${fn}(`), sql.indexOf(`create function ${fn}(`) + 700);
      expect(head, fn).toContain("set search_path = public, pg_temp");
      expect(head, fn).toContain(fn === "report_income_by_session_type" ? "security definer" : "security invoker");
      const sig = `${fn}(${sqlFns[fn].map(() => "date").join(", ")})`;
      expect(sql, fn).toContain(`revoke execute on function ${sig} from public, anon;`);
      expect(sql, fn).toContain(`grant execute on function ${sig} to authenticated, service_role;`);
    }
  });
  it("starts every function with its role guard and its range check", () => {
    for (const fn of Object.keys(sqlFns)) {
      const body = sql.slice(sql.indexOf(`create function ${fn}(`));
      const begin = body.slice(body.indexOf("begin"));
      expect(begin.split("\n")[1], fn).toContain("raise exception 'forbidden'");
      expect(begin.split("\n")[2], fn).toContain("raise exception 'invalid_range'");
    }
  });
});
