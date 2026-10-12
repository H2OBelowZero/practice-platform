import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { staffNav } from "@/lib/nav";
import { PATIENT_TABS } from "@/app/app/patients/[id]/tabs";
import { MANUAL_SUBMISSION_NOTE } from "@/lib/claims/view";

// Tripwires for the medical aid and claims code (Task 14). Claims hold ICD-10 codes, which are clinical information: they must never reach a list page,
// a URL, a log, an audit detail, an outbox payload, a page title or the patient portal, and every claims route is psychologist / admin only.
// Also the R34 call-site audit: the columns and RPC arguments the app uses must exist in the migrations.
const root = join(__dirname, "..", "..");
const sql = readdirSync(join(root, "supabase", "migrations")).sort().map((f) => readFileSync(join(root, "supabase", "migrations", f), "utf8")).join("\n").replace(/--.*$/gm, "");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : [p];
});
const rel = (f: string) => relative(root, f).replace(/\\/g, "/");
const read = (f: string) => readFileSync(f, "utf8");
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const code = (f: string) => noComments(read(f));

const claimFiles = [
  ...walk(join(root, "app", "app", "claims")), ...walk(join(root, "lib", "claims")),
  join(root, "app", "app", "patients", "[id]", "tab-medical-aid.tsx"), join(root, "app", "app", "patients", "[id]", "member-fields.tsx"),
].filter((f) => /\.tsx?$/.test(f));
const pages = claimFiles.filter((f) => f.endsWith("page.tsx"));
const actionsFile = join(root, "app", "app", "claims", "actions.ts");
const listPage = join(root, "app", "app", "claims", "page.tsx");

/** the top-level arguments of every call to `name(` in `src` (parentheses, braces, brackets and quotes balanced) */
function callArgs(src: string, name: string): string[][] {
  const out: string[][] = [];
  for (const m of src.matchAll(new RegExp(String.raw`\b${name.replace(".", String.raw`\.`)}\(`, "g"))) {
    let depth = 1, i = m.index + m[0].length, cur = "", quote = "";
    const args: string[] = [];
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) { cur += ch; if (ch === "\\") cur += src[++i]; else if (ch === quote) quote = ""; continue; }
      if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; cur += ch; continue; }
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth === 0) break; }
      if (ch === "," && depth === 1) { args.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push(args);
  }
  return out;
}

describe("the claims code is where the tests expect it", () => {
  it("finds the files it guards", () => {
    expect(claimFiles.length).toBeGreaterThanOrEqual(14);
    expect(pages.map(rel).sort()).toEqual(["app/app/claims/[claimId]/page.tsx", "app/app/claims/new/page.tsx", "app/app/claims/page.tsx"]);
  });
  it("the scanner handles nesting and quotes", () => {
    expect(callArgs(`x audit("a,b", "c", f(1, 2), { p: [1, 2], q: "}" })`, "audit")).toEqual([["\"a,b\"", "\"c\"", "f(1, 2)", "{ p: [1, 2], q: \"}\" }"]]);
  });
});

describe("access", () => {
  it("every claims page, and the medical aid tab's actions, call requireRole(psychologist, admin) themselves (R26)", () => {
    for (const f of pages) expect(read(f), rel(f)).toMatch(/requireRole\(\["psychologist", "admin"\]\)/);
    const src = read(actionsFile);
    expect(src).toMatch(/const STAFF = \["psychologist", "admin"\] as const/);
    const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]).sort();
    expect(exported).toEqual(["markAccepted", "markRejected", "markSubmitted", "openClaim", "recordRemittance", "resubmit", "returnToDraft", "saveMember", "searchIcd10", "updateClaim"]);
    expect(src).not.toMatch(/export (?!async function)/); // a "use server" file exports async functions only
    for (const name of exported) {
      if (name === "markSubmitted" || name === "resubmit") continue; // thin wrappers around send(), which gates itself
      const body = src.slice(src.indexOf(`export async function ${name}`)).split(/\nexport /)[0];
      // the code search is for the practitioner alone: the admin cannot write diagnosis codes and has no reason to browse them
      expect(body, name).toMatch(name === "searchIcd10" ? /await requireRole\(\[\.\.\.PSY\]\)/ : /await requireRole\(\[\.\.\.STAFF\]\)/);
    }
    expect(src).toMatch(/const PSY = \["psychologist"\] as const/);
    expect(src.slice(src.indexOf("async function send("))).toMatch(/^async function send\([^]*?await requireRole\(\[\.\.\.STAFF\]\)/);
  });
  it("the Claims link and the Medical aid tab are psychologist / admin only; the bookkeeper and associate see neither", () => {
    expect(staffNav("psychologist").some((i) => i.href === "/app/claims")).toBe(true);
    expect(staffNav("admin").some((i) => i.href === "/app/claims")).toBe(true);
    for (const r of ["bookkeeper", "associate", "patient", "guardian"] as const) expect(staffNav(r).some((i) => i.href === "/app/claims"), r).toBe(false);
    expect(PATIENT_TABS.find((t) => t.key === "medical-aid")?.roles).toEqual(["psychologist", "admin"]);
  });
  it("the invoice page offers claim links to writers only (the bookkeeper reads claim_summary status and amounts, no links)", () => {
    const inv = read(join(root, "app", "app", "billing", "[invoiceId]", "page.tsx"));
    expect(inv).toMatch(/\{write && <Link href=\{`\/app\/claims\/\$\{c\.id\}`\}>Open claim<\/Link>\}/);
    expect(inv).toMatch(/const canOpenClaim = write && open/);
    expect(inv).toMatch(/from\("claim_summary"\)\.select\("id, status, claimed_cents, approved_cents"\)/);
  });
  it("page titles are fixed text: no names, codes or references, no generateMetadata", () => {
    for (const f of pages) {
      expect(read(f), rel(f)).toMatch(/export const metadata = \{ title: "[^"$`]+" \}/);
      expect(read(f), rel(f)).not.toMatch(/generateMetadata/);
    }
  });
});

describe("ICD-10 codes stay on the claim itself", () => {
  it("the claims list page never mentions or selects diagnosis codes", () => {
    expect(code(listPage)).not.toMatch(/icd10/i);
  });
  it("outside the claims code, nothing in app/ or lib/ reads or writes icd10 (billing, reports, tasks, dashboard, portal)", () => {
    const users = [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components"))].filter((f) => /\.tsx?$/.test(f) && /icd10/i.test(code(f))).map(rel);
    expect(users.length).toBeGreaterThan(3);
    for (const f of users) expect(f, f).toMatch(/^(app\/app\/claims\/|lib\/claims\/)/);
  });
  it("the patient portal reads no claim, claim event, claim summary, claim payment, member or diagnosis data (anywhere under app/portal or lib/portal)", () => {
    const portal = [...walk(join(root, "app", "portal")), ...walk(join(root, "lib", "portal"))].filter((f) => /\.tsx?$/.test(f));
    expect(portal.length).toBeGreaterThan(10);
    for (const f of portal) expect(code(f), rel(f)).not.toMatch(/icd10|from\("claims?[a-z_]*"\)|claim_events|claim_summary|claim_payments|medical_aid_members|record_scheme_remittance|\/app\/claims/i);
  });
  it("no console.* anywhere in the claims code (nothing to log: codes, reasons and member numbers must not reach logs)", () => {
    for (const f of claimFiles) expect(read(f), rel(f)).not.toMatch(/\bconsole\s*\./);
  });
  it("the claims code never uses the service client or the outbox (nothing is queued or written outside RLS)", () => {
    for (const f of claimFiles) expect(read(f), rel(f)).not.toMatch(/supabaseService|notifications_outbox|dangerouslySetInnerHTML/);
  });
  it("audit calls carry an action, an entity, an id and ids (or field names) only: never a code, reason, reference, amount or member number", () => {
    const calls = claimFiles.flatMap((f) => callArgs(code(f), "audit").map((args) => ({ f: rel(f), args })));
    expect(calls.length).toBeGreaterThanOrEqual(9);
    const actions = new Set(calls.flatMap((c) => [...c.args[0].matchAll(/"((?:claim|member)\.\w+)"/g)].map((m) => m[1])));
    expect([...actions].sort()).toEqual(["claim.create", "claim.reject", "claim.resubmit", "claim.submit", "claim.update", "claim.view", "claim.accept", "claim.reopen", "member.create", "member.update"].sort());
    for (const c of calls) {
      expect(c.args.length, `${c.f}: ${c.args.join(" | ")}`).toBeGreaterThanOrEqual(3);
      expect(c.args.length, c.f).toBeLessThanOrEqual(4);
      const detail = (c.args[3] ?? "").replace(/Object\.keys\(patch\)/g, "FIELD_NAMES").replace(/\s+/g, " ");
      expect(detail, c.f).not.toMatch(/icd|code|reason|ref\b|number|amount|cents|value|diagnos|member_number|scheme|text|tariff/i);
    }
    expect(read(join(root, "app", "app", "claims", "[claimId]", "page.tsx"))).toMatch(/\n  await audit\("claim\.view", "claims", claim\.id, \{ invoice_id: claim\.invoice_id, patient_id: inv\.patient_id \}\);/); // awaited, not inside safely(): fail-closed
    const act = code(actionsFile);
    for (const m of act.matchAll(/audit\(/g)) expect(act.slice(Math.max(0, m.index - 80), m.index), "app audits are fail-open follow-ups").toMatch(/safely\(/);
  });
  it("redirects and links carry ids and notice codes only: no placeholder names a code, reason, reference, number or value", () => {
    const sinks = ["redirect", "hrefWith"];
    const bad = /icd|code|reason|\bref\b|number|member_|value|diagnos|scheme|amount|text/i;
    const placeholders = (s: string) => [...s.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    for (const f of claimFiles) {
      const src = code(f);
      for (const name of sinks) for (const args of callArgs(src, name)) for (const p of placeholders(args.join(","))) expect(p, `${rel(f)} ${name}`).not.toMatch(bad);
      for (const m of src.matchAll(/(?:href|location\.href)\s*=\s*\{?`([^`]*)`/g)) for (const p of placeholders(m[1])) expect(p, `${rel(f)} href`).not.toMatch(bad);
    }
    expect(callArgs(code(actionsFile), "redirect").length).toBeGreaterThanOrEqual(2);
  });
});

describe("the manual submission note", () => {
  it("is shown, word for word, on the list, the new claim page and the claim page", () => {
    expect(MANUAL_SUBMISSION_NOTE).toBe("Submission is tracked manually in this version; submit through your scheme or clearing house and record the outcome here.");
    for (const f of pages) expect(read(f), rel(f)).toMatch(/\{MANUAL_SUBMISSION_NOTE\}/);
  });
});

describe("R34 call sites match the SQL", () => {
  /** columns of a table: its create table body plus later `alter table ... add column` statements */
  function tableColumns(table: string): Set<string> {
    const cols = new Set<string>();
    const start = sql.search(new RegExp(`create table ${table} \\(`));
    let depth = 0, i = sql.indexOf("(", start), seg = "";
    const parts: string[] = [];
    for (; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "(") { depth++; if (depth === 1) continue; }
      if (ch === ")") { depth--; if (depth === 0) { parts.push(seg); break; } }
      if (ch === "," && depth === 1) { parts.push(seg); seg = ""; continue; }
      seg += ch;
    }
    for (const p of parts) {
      const w = p.trim().split(/\s+/)[0]?.toLowerCase();
      if (w && !["constraint", "primary", "unique", "check", "foreign"].includes(w)) cols.add(w);
    }
    for (const m of sql.matchAll(new RegExp(`alter table ${table} add column (\\w+)`, "g"))) cols.add(m[1]);
    return cols;
  }
  /** parameter names of the LAST definition of a function */
  function sqlParams(fn: string): string[] {
    const defs = [...sql.matchAll(new RegExp("create (?:or replace )?function " + fn + "[(]([\\s\\S]*?)[)]\\s*returns", "g"))];
    if (defs.length === 0) throw new Error(`no SQL function ${fn}`);
    return defs[defs.length - 1][1].split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
  }
  /** top-level column names of a PostgREST select list; an embed `name(cols)` / `name!inner(cols)` is returned with its inner columns */
  function selectCols(list: string): { table?: string; cols: string[] }[] {
    const out: { table?: string; cols: string[] }[] = [{ cols: [] }];
    let depth = 0, cur = "";
    const flush = () => {
      const t = cur.trim(); cur = "";
      if (!t) return;
      const em = /^(\w+)(?:!inner)?\(([^)]*)\)$/.exec(t);
      if (em) out.push({ table: em[1], cols: em[2].split(",").map((c) => c.trim()).filter(Boolean) }); else out[0].cols.push(t);
    };
    for (const ch of list) { if (ch === "(") depth++; if (ch === ")") depth--; if (ch === "," && depth === 0) flush(); else cur += ch; }
    flush();
    return out;
  }

  it("record_scheme_remittance is called with exactly the parameters the SQL declares, and nothing else writes the ledger", () => {
    const src = code(actionsFile);
    const call = /\.rpc\("record_scheme_remittance", \{([^}]*)\}\)/.exec(src);
    expect(call).not.toBeNull();
    const sent = [...call![1].matchAll(/\b(p_[a-z_]+)\s*:/g)].map((m) => m[1]);
    expect(sent.sort()).toEqual(sqlParams("record_scheme_remittance").sort());
    expect(sql).toMatch(/create function record_scheme_remittance\(p_claim uuid, p_amount int, p_ref text\)/);
    const rpcs = claimFiles.flatMap((f) => [...code(f).matchAll(/\.rpc\(\s*"(\w+)"/g)].map((m) => m[1]));
    expect(rpcs).toEqual(["record_scheme_remittance"]);
    for (const f of claimFiles) expect(code(f), rel(f)).not.toMatch(/from\("(payments|claim_payments|claim_events|icd10_codes|invoices|credit_notes|tasks|audit_log)"\)\s*\.(insert|update|upsert|delete)/);
    for (const f of claimFiles) expect(code(f), rel(f)).not.toMatch(/\.(delete|upsert)\(/); // members and claims are never deleted
  });
  it("the columns written to claims and medical_aid_members exist", () => {
    const src = code(actionsFile);
    const written = new Set<string>();
    for (const m of src.matchAll(/\b(?:patch|row)\.(\w+)\s*=/g)) written.add(m[1]);
    for (const m of src.matchAll(/\.update\(\{([^}]*)\}\)/g)) for (const k of m[1].matchAll(/\b(\w+)\s*:/g)) written.add(k[1]);
    const row = /const row: Record<string, unknown> = \{([^}]*)\}/.exec(src);
    for (const k of row![1].matchAll(/\b(\w+)\s*:/g)) written.add(k[1]);
    expect([...written].sort()).toEqual(["approved_cents", "claim_ref", "claimed_cents", "icd10_codes", "invoice_id", "member_id", "preauth_ref", "rejection_reason", "status", "tariff_code"]);
    const claims = tableColumns("claims");
    for (const c of written) expect(claims.has(c), `claims.${c}`).toBe(true);
    const members = tableColumns("medical_aid_members");
    const cols = /const MEMBER_COLS = \[([^\]]*)\]/.exec(src)![1].match(/"(\w+)"/g)!.map((s) => s.replaceAll("\"", ""));
    expect(cols.length).toBe(7);
    for (const c of [...cols, "patient_id"]) expect(members.has(c), `medical_aid_members.${c}`).toBe(true);
  });
  it("every column the claims code selects exists on that table (including the claim_events, claim_payments and icd10_codes reads)", () => {
    const reads: { f: string; table: string; cols: string[] }[] = [];
    const add = (f: string, table: string, list: string) => {
      for (const part of selectCols(list.replace(/\$\{[^}]*\}/g, ""))) reads.push({ f, table: part.table ?? table, cols: part.cols });
    };
    for (const f of claimFiles) {
      const src = code(f);
      for (const m of src.matchAll(/\.from\("(\w+)"\)\s*\.select\(\s*(?:"([^"]+)"|`([^`]+)`)/g)) add(rel(f), m[1], m[2] ?? m[3]);
      for (const m of src.matchAll(/\.from\("(\w+)"\)\s*\.select\(\s*\n?\s*(?:`([^`]+)`|"([^"]+)")/g)) add(rel(f), m[1], m[2] ?? m[3]);
      for (const m of src.matchAll(/const CLAIM_COLS = "([^"]+)"/g)) add(rel(f), "claims", m[1]);
      for (const m of src.matchAll(/\.from\("(\w+)"\)\s*\.select\(\s*(?:[^"`]*?\?\s*)?"([^"]+)"/g)) add(rel(f), m[1], m[2]);
    }
    const tables = new Set(reads.map((r) => r.table));
    for (const t of ["claims", "claim_events", "claim_payments", "icd10_codes", "medical_aid_members", "invoices", "payments", "credit_notes", "patients", "profiles", "invoice_lines"]) expect(tables.has(t), `reads ${t}`).toBe(true);
    for (const r of reads) {
      if (["head"].includes(r.cols[0])) continue;
      const known = r.table === "profiles" || r.table === "patients" ? null : tableColumns(r.table);
      if (!known) continue; // profiles and patients are checked by their own tasks' tests
      for (const c of r.cols) expect(known.has(c), `${r.f}: ${r.table}.${c}`).toBe(true);
    }
  });
  it("the claim_summary view still holds only what the bookkeeper may see (status and amounts, no codes, member or patient)", () => {
    const def = /create view claim_summary [^;]*;/.exec(sql)![0];
    expect(def).toMatch(/select c\.id, c\.invoice_id, c\.status, c\.claimed_cents, c\.approved_cents, c\.submitted_at from claims c/);
    expect(def).not.toMatch(/icd10|member|patient/);
  });
});
