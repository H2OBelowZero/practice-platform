import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// R34 tripwires for the portal Payments code: every column read from the database exists in the migrations, the portal never reads what a patient
// must not see, the PayFast checkout is built in exactly one place with the server-computed amount, and every portal page / action gates itself.
const root = join(__dirname, "..", "..");
const sql = readdirSync(join(root, "supabase", "migrations")).sort().map((f) => readFileSync(join(root, "supabase", "migrations", f), "utf8")).join("\n").replace(/--.*$/gm, ""); // SQL comments out

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const portalFiles = [...walk(join(root, "app", "portal", "payments")), join(root, "app", "portal", "page.tsx"), ...walk(join(root, "lib", "portal"))].filter((f) => /\.tsx?$/.test(f));
const src = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(root, f).replace(/\\/g, "/");

/** columns of a table: its create table body plus later `alter table ... add column` statements */
function tableColumns(table: string): Set<string> {
  const cols = new Set<string>();
  const start = sql.search(new RegExp(`create table ${table} \\(`));
  if (start >= 0) {
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
  }
  for (const m of sql.matchAll(new RegExp(`alter table ${table} add column (\\w+)`, "g"))) cols.add(m[1]);
  return cols;
}
/** columns of the LAST definition of a view */
function viewColumns(view: string): Set<string> {
  const defs = [...sql.matchAll(new RegExp(`create (?:or replace )?view ${view} [\\s\\S]*?;`, "g"))];
  const body = defs[defs.length - 1][0];
  return new Set([...body.matchAll(/\bas (\w+)\s*[,\n]/g)].map((m) => m[1]).concat([...body.matchAll(/\bi\.(\w+)/g)].map((m) => m[1])));
}
const columnsOf = (name: string) => (name === "invoice_balances" ? viewColumns(name) : tableColumns(name));

describe("portal reads", () => {
  const reads: { file: string; table: string; cols: string[] }[] = [];
  for (const f of portalFiles) {
    for (const m of src(f).matchAll(/\.from\("(\w+)"\)\s*\.select\(\s*(?:[^"]*?\?\s*)?"([^"]+)"/g)) {
      reads.push({ file: rel(f), table: m[1], cols: m[2].split(",").map((c) => c.trim()).filter(Boolean) });
    }
  }
  // lib/portal/load.ts keeps its columns in constants
  const loadSrc = src(join(root, "lib", "portal", "load.ts"));
  const invoiceCols = /const INVOICE_COLS = "([^"]+)"/.exec(loadSrc)![1].split(",").map((c) => c.trim());
  reads.push({ file: "lib/portal/load.ts", table: "invoice_balances", cols: invoiceCols });

  it("finds the reads it is meant to check", () => {
    expect(reads.length).toBeGreaterThan(12);
    expect(new Set(reads.map((r) => r.table))).toEqual(new Set(["invoice_balances", "payments", "credit_notes", "patients", "invoices", "invoice_lines", "profiles"]));
  });
  it("every selected column exists in the migrations", () => {
    for (const r of reads) {
      const known = columnsOf(r.table);
      expect(known.size, `${r.table} parsed`).toBeGreaterThan(2);
      for (const c of r.cols) expect(known.has(c), `${r.file}: ${r.table}.${c}`).toBe(true);
    }
  });
  it("invoice_balances has the credit columns 0017 added", () => {
    const v = viewColumns("invoice_balances");
    for (const c of ["credit_cents", "scheme_credit_cents", "patient_credit_cents", "outstanding_cents", "paid_cents"]) expect(v.has(c), c).toBe(true);
  });
  it("never reads what a patient must not see: claims, ICD-10, claim summaries, member identity, the free-text credit note reason, the audit log", () => {
    for (const f of portalFiles) {
      const s = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
      expect(s, rel(f)).not.toMatch(/claim|icd10|medical_aid_members|audit_log|\breason\b.*credit_notes|credit_notes.*"[^"]*\breason\b/i);
    }
    for (const r of reads.filter((x) => x.table === "credit_notes")) expect(r.cols, r.file).not.toContain("reason");
  });
  it("drafts are excluded from every invoice read (RLS hides them too)", () => {
    for (const f of portalFiles.filter((p) => /\[invoiceId\]|load\.ts/.test(p))) {
      const s = src(f);
      if (/from\("invoices"\)|from\("invoice_balances"\)/.test(s)) expect(s, rel(f)).toMatch(/neq\("status", "draft"\)/);
    }
  });
});

describe("portal gates and the service client", () => {
  const pages = portalFiles.filter((f) => /page\.tsx$/.test(f) || /actions\.ts$/.test(f));
  it("every portal payments page and action calls requireRole(['patient','guardian']) itself (R26)", () => {
    expect(pages.length).toBeGreaterThanOrEqual(5);
    for (const f of pages) expect(src(f), rel(f)).toMatch(/requireRole\(\["patient", "guardian"\]\)/);
  });
  it("nothing in the portal payments code uses the service-role client: reads are the user's own (RLS); only audit() writes", () => {
    for (const f of portalFiles) expect(src(f), rel(f)).not.toMatch(/supabaseService|SUPABASE_SERVICE_ROLE_KEY/);
  });
  it("the portal never writes money or invoices", () => {
    for (const f of portalFiles) expect(src(f), rel(f)).not.toMatch(/\.(insert|update|upsert|delete)\(|record_payment|record_scheme_remittance|invoice_recompute/);
  });
});

describe("PayFast checkout call sites", () => {
  const all = [...walk(join(root, "app")), ...walk(join(root, "lib"))].filter((f) => /\.tsx?$/.test(f));
  it("buildCheckout( is called in exactly one place: the portal action", () => {
    const callers = all.filter((f) => /\bbuildCheckout\(/.test(src(f)) && !/export function buildCheckout/.test(src(f))).map(rel);
    expect(callers).toEqual(["app/portal/payments/actions.ts"]);
  });
  it("it is given the amount the server decided, the invoice id that was validated, and the verified user's name and email", () => {
    const a = src(join(root, "app", "portal", "payments", "actions.ts"));
    expect(a).toMatch(/amountCents: decision\.amountCents/);
    expect(a).toMatch(/invoiceId: id\.data/);
    expect(a).toMatch(/name: who\.name, email: who\.email/);
    expect(a).not.toMatch(/amountCents: (raw|seen)/i);
    expect(a).toMatch(/auth\.getUser\(\)/);
  });
  it("the pay-now client component sends no amount other than the displayed figure and builds no checkout itself", () => {
    const c = src(join(root, "app", "portal", "payments", "pay-now.tsx"));
    expect(c).not.toMatch(/buildCheckout|payfastSignature|merchant/i);
    expect(c).toMatch(/method="post"/);
  });
  it("the return page and the pages show stored status only: no code path marks anything paid", () => {
    for (const f of portalFiles) expect(src(f), rel(f)).not.toMatch(/status: ?["']paid["']|set status/i);
  });
});

describe("staff credit note call site (0017)", () => {
  it("the credit_notes insert sends the portion, and the parsed portion only", () => {
    const a = src(join(root, "app", "app", "billing", "actions.ts"));
    expect(a).toMatch(/from\("credit_notes"\)\.insert\(\{[^}]*portion: c\.value\.portion/);
    expect(a).toMatch(/parseCreditNoteForm\(values, String\(payerRow\.payer_type\)\)/);
  });
});
