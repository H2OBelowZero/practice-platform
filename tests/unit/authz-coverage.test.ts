import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Static authorisation tripwire (R26: middleware and layouts are NOT authorisation).
 *
 * Every page.tsx, every route.ts handler and every exported server action must either
 *   - be in an explicit allow-list below, with a reason (public, or authenticated by its own mechanism), or
 *   - call requireRole( / requireUser( / requireRecoverySession( BEFORE its first data access.
 * A failing run names the file (and function). This is a text-level check on purpose: it catches the realistic mistake
 * (a new page or action added without a guard), not a determined attacker. Known limits, so nobody trusts it more than it deserves:
 *   - "data access" means .from( / .rpc( / getPractice( / getCrisisText( / audit( in the function itself or in a function
 *     declared in the same file that it calls. A helper imported from another module is not looked into.
 *   - it proves a guard is called, not that the allowed roles are right. Role lists are reviewed by hand and tested per feature.
 */

// ---- allow-lists: every entry needs a reason; a stale entry (file or function gone) fails too ----
type Own = { auth: RegExp; before?: RegExp };
const PUBLIC_PAGES: Record<string, { reason: string; own?: Own }> = {
  "app/page.tsx": { reason: "landing page" },
  "app/(public)/book/page.tsx": { reason: "booking starts anonymously (slots are public); booking itself needs requireRole in bookAppointment" },
  "app/(auth)/register/page.tsx": { reason: "sign-up form" },
  "app/(auth)/login/page.tsx": { reason: "sign-in form" },
  "app/(auth)/recover/page.tsx": { reason: "request a password-reset email" },
  "app/(auth)/mfa/page.tsx": { reason: "pre-MFA session: requireUser would redirect here in a loop, so it checks currentUser() and the role itself", own: { auth: /\bcurrentUser\(/, before: /\.mfa\./ } },
};
// keyed "file#METHOD"
const PUBLIC_ROUTES: Record<string, { reason: string; own?: Own }> = {
  "app/api/payfast/itn/route.ts#POST": { reason: "PayFast webhook: signature + IP + server confirmation inside processItn", own: { auth: /\bprocessItn\(/ } },
  "app/api/payfast/itn/route.ts#GET": { reason: "405 stub, reads nothing" },
  "app/api/cron/reminders/route.ts#GET": { reason: "Vercel cron: Bearer CRON_SECRET, constant-time compare (GET = POST = run)", own: { auth: /\bbearerMatches\(/, before: /\bserviceRpc\(|\brunWorker\(/ } },
  "app/api/cron/reminders/route.ts#POST": { reason: "same handler as GET", own: { auth: /\bbearerMatches\(/, before: /\bserviceRpc\(|\brunWorker\(/ } },
  "app/auth/callback/route.ts#GET": { reason: "email-link landing: one-time PKCE code is the credential (exchangeCodeForSession)", own: { auth: /\bexchangeCodeForSession\(/ } },
};
const PUBLIC_ACTIONS: Record<string, { reason: string; own?: Own }> = {
  "app/(auth)/actions.ts#signIn": { reason: "sign-in" },
  "app/(auth)/actions.ts#signOut": { reason: "sign-out works for any session (or none)" },
  "app/(auth)/actions.ts#register": { reason: "patient self-sign-up; the signup trigger always creates a patient profile" },
  "app/(auth)/actions.ts#requestRecovery": { reason: "sends a reset email; same answer whether or not the address exists" },
  "app/(auth)/actions.ts#startMfaEnrolment": { reason: "pre-MFA session cannot pass requireUser", own: { auth: /\bcurrentUser\(/ } },
  "app/(auth)/actions.ts#verifyMfa": { reason: "pre-MFA session cannot pass requireUser", own: { auth: /\bcurrentUser\(/ } },
};

// ---- the analyser (exported-looking helpers live here so the self-tests below can feed it fabricated sources) ----
const GUARD = /\b(?:requireRole|requireUser|requireRecoverySession)\(/g;
const DATA = /\.from\(|\.rpc\(|\bgetPractice\(|\bgetCrisisText\(|\baudit\(/g;
const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Blank out comments and string/template contents (keeping code inside `${}`), preserving length and newlines. */
function strip(src: string): string {
  function scan(i: number, inExpr: boolean): [string, number] {
    let out = ""; let depth = 0;
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
      if (c === "/" && n === "*") {
        const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2;
        out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue;
      }
      if (c === '"' || c === "'") { // ends at the closing quote or the end of the line (JSX text can contain a lone apostrophe)
        let j = i + 1;
        while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        out += c + " ".repeat(Math.max(0, j - i - 1)) + (src[j] === c ? c : ""); i = src[j] === c ? j + 1 : j; continue;
      }
      if (c === "`") {
        out += "`"; i++;
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") { out += "  "; i += 2; continue; }
          if (src[i] === "$" && src[i + 1] === "{") { const [inner, k] = scan(i + 2, true); out += "${" + inner + "}"; i = k + 1; continue; }
          out += src[i] === "\n" ? "\n" : " "; i++;
        }
        out += "`"; i++; continue;
      }
      if (c === "/" && /(?:^|[(,=:[!&|?{;+\-*%~^]|\breturn|\btypeof)\s*$/.test(out.slice(-12))) { // regex literal (not division): skip to the closing slash, honouring [...] classes
        let j = i + 1, cls = false;
        while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
        if (src[j] === "/") { out += "/" + " ".repeat(j - i - 1) + "/"; i = j + 1; while (/[a-z]/.test(src[i] ?? "")) { out += " "; i++; } continue; }
      }
      if (inExpr) { if (c === "{") depth++; else if (c === "}") { if (depth === 0) return [out, i]; depth--; } }
      out += c; i++;
    }
    return [out, i];
  }
  return scan(0, false)[0];
}

/** The text between the braces of `function <name>(...) { ... }`, or null if it cannot be found. Needs stripped code. */
function bodyOf(code: string, name: string): string | null {
  const m = new RegExp(`\\bfunction\\s+${name}\\s*[(<]`).exec(code);
  if (!m) return null;
  let i = code.indexOf("(", m.index);
  let paren = 0;
  for (; i < code.length; i++) { if (code[i] === "(") paren++; else if (code[i] === ")" && --paren === 0) break; }
  let angle = 0;
  for (i++; i < code.length; i++) { // the return type may contain braces (Promise<{ ok: true }>): only a `{` outside <> starts the body
    if (code[i] === "<") angle++; else if (code[i] === ">" && code[i - 1] !== "=") angle--;
    else if (code[i] === "{" && angle <= 0) break;
  }
  if (i >= code.length) return null;
  let depth = 0; const start = i;
  for (; i < code.length; i++) { if (code[i] === "{") depth++; else if (code[i] === "}" && --depth === 0) return code.slice(start + 1, i); }
  return null;
}

function localFunctions(code: string): Map<string, string> {
  const fns = new Map<string, string>();
  for (const m of code.matchAll(/(?:^|[\s;}])function\s+([A-Za-z_$][\w$]*)/g)) { const b = bodyOf(code, m[1]); if (b !== null) fns.set(m[1], b); }
  return fns;
}

type Event = "guard" | "data" | "none";
/** What happens first when `name` runs: a guard call, a data access, or neither. Follows calls to functions declared in the same file. */
function firstEvent(name: string, fns: Map<string, string>, seen = new Set<string>()): Event {
  const body = fns.get(name);
  if (body === undefined || seen.has(name)) return "none";
  seen.add(name);
  const events: { at: number; kind: "guard" | "data" | string }[] = [];
  for (const m of body.matchAll(GUARD)) events.push({ at: m.index!, kind: "guard" });
  for (const m of body.matchAll(DATA)) events.push({ at: m.index!, kind: "data" });
  for (const other of fns.keys()) if (other !== name) for (const m of body.matchAll(new RegExp(`(?<![\\w$.])${other.replace("$", "\\$")}\\(`, "g"))) events.push({ at: m.index!, kind: other });
  events.sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.kind === "guard" || e.kind === "data") return e.kind;
    const r = firstEvent(e.kind, fns, seen);
    if (r !== "none") return r;
  }
  return "none";
}

/** Violations for one function: empty when it is allowed or guarded before its first data access. */
function check(file: string, fn: string, code: string, fns: Map<string, string>, allow?: { reason: string; own?: Own }): string[] {
  const where = `${file} (${fn})`;
  const body = fns.get(fn);
  if (body === undefined) return [`${where}: cannot find the function body: use a plain function declaration so the tripwire can read it`];
  if (allow) {
    if (!allow.own) return [];
    const at = body.search(allow.own.auth);
    if (at < 0) return [`${where}: allow-listed as self-authenticating but ${allow.own.auth} is not called`];
    const data = allow.own.before ? body.search(allow.own.before) : -1;
    return data >= 0 && data < at ? [`${where}: reaches ${allow.own.before} before ${allow.own.auth}`] : [];
  }
  const e = firstEvent(fn, fns);
  if (e === "guard") return [];
  return [e === "data"
    ? `${where}: reads data BEFORE calling requireRole/requireUser/requireRecoverySession`
    : `${where}: no requireRole/requireUser/requireRecoverySession call (add one, or add it to the allow-list in authz-coverage.test.ts with a reason)`];
}

/** Exported functions of a source: declarations only; any other export form fails loudly instead of slipping past. */
function exportedFunctions(file: string, code: string, only?: string[]): { names: string[]; problems: string[] } {
  const names: string[] = []; const problems: string[] = [];
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) if (!only || only.includes(m[1])) names.push(m[1]);
  if (!only) {
    for (const m of code.matchAll(/\bexport\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/g)) problems.push(`${file} (${m[1]}): exported arrow function: use \`export async function\` so the tripwire can read it`);
    if (/\bexport\s*\{/.test(code) || /\bexport\s*\*/.test(code)) problems.push(`${file}: re-exports (export { } / export *) hide functions from the tripwire`);
  }
  return { names, problems };
}

// ---- file discovery ----
const ROOT = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "node_modules" && n !== ".next") walk(p, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const files = ["app", "lib", "components"].flatMap((d) => walk(join(ROOT, d))).map((p) => ({ file: rel(p), src: readFileSync(p, "utf8") }));
const pages = files.filter((f) => f.file.startsWith("app/") && /(^|\/)page\.tsx$/.test(f.file));
const routes = files.filter((f) => f.file.startsWith("app/") && /(^|\/)route\.ts$/.test(f.file));
const actionFiles = files.filter((f) => /^\s*["']use server["'];?\s*$/m.test(f.src));

describe("authorisation tripwire: coverage of what exists", () => {
  it("finds the pages, routes and action files (the walk is not vacuous)", () => {
    expect(pages.length).toBeGreaterThan(40);
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(actionFiles.length).toBeGreaterThanOrEqual(15);
  });
  it("only app/ files are server-action files (a use-server file elsewhere would escape the per-folder reasoning)", () => {
    expect(actionFiles.filter((f) => !f.file.startsWith("app/")).map((f) => f.file)).toEqual([]);
  });
  it("the stripper keeps braces balanced in every file (otherwise function bodies would be mis-read)", () => {
    const bad = files.filter((f) => { const s = strip(f.src); return (s.match(/\{/g) ?? []).length !== (s.match(/\}/g) ?? []).length; }).map((f) => f.file);
    expect(bad).toEqual([]);
  });
  it("allow-list entries still exist (no stale exemptions)", () => {
    const stale = [
      ...Object.keys(PUBLIC_PAGES).filter((k) => !pages.some((p) => p.file === k)),
      ...Object.keys(PUBLIC_ROUTES).filter((k) => !routes.some((p) => p.file === k.split("#")[0] && new RegExp(`\\bexport\\s+(?:async\\s+function|const)\\s+${k.split("#")[1]}\\b`).test(strip(p.src)))),
      ...Object.keys(PUBLIC_ACTIONS).filter((k) => { const [f, n] = k.split("#"); const a = actionFiles.find((x) => x.file === f); return !a || !exportedFunctions(f, strip(a.src)).names.includes(n); }),
    ];
    expect(stale).toEqual([]);
  });
});

describe("authorisation tripwire: pages", () => {
  it("every page is public-by-allow-list or guards before reading data", () => {
    const bad = pages.flatMap((p) => {
      const code = strip(p.src);
      const { names } = exportedFunctions(p.file, code);
      const def = /\bexport\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(code)?.[1];
      if (!def || !names.includes(def)) return [`${p.file}: no \`export default [async] function Name\` page component`];
      return check(p.file, def, code, localFunctions(code), PUBLIC_PAGES[p.file]);
    });
    expect(bad).toEqual([]);
  });
});

describe("authorisation tripwire: route handlers", () => {
  it("every exported HTTP handler is guarded or allow-listed with its own auth", () => {
    const bad = routes.flatMap((r) => {
      const code = strip(r.src);
      const { names } = exportedFunctions(r.file, code, HTTP);
      // `export const GET = run;` is allowed when `run` is a function declared in this file; any other const form is refused
      const aliases = HTTP.flatMap((h) => { const m = new RegExp(`\\bexport\\s+const\\s+${h}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*;`).exec(code); return m ? [{ method: h, fn: m[1] }] : []; });
      const unsupported = HTTP.filter((h) => !names.includes(h) && !aliases.some((a) => a.method === h) && new RegExp(`\\bexport\\s+(?:const|let)\\s+${h}\\b`).test(code))
        .map((h) => `${r.file} (${h}): exported in a form the tripwire cannot read: use \`export async function ${h}\` or \`export const ${h} = namedFunction;\``);
      const handlers = [...names.map((n) => ({ method: n, fn: n })), ...aliases];
      if (handlers.length === 0 && unsupported.length === 0) return [`${r.file}: exports no HTTP handler`];
      const fns = localFunctions(code);
      return [...unsupported, ...handlers.flatMap((h) => check(`${r.file} ${h.method}`, h.fn, code, fns, PUBLIC_ROUTES[`${r.file}#${h.method}`]))];
    });
    expect(bad).toEqual([]);
  });
});

describe("authorisation tripwire: server actions", () => {
  it("every exported action guards before reading data, or is allow-listed", () => {
    const bad = actionFiles.flatMap((a) => {
      const code = strip(a.src);
      const { names, problems } = exportedFunctions(a.file, code);
      const fns = localFunctions(code);
      return [...problems, ...names.flatMap((n) => check(a.file, n, code, fns, PUBLIC_ACTIONS[`${a.file}#${n}`]))];
    });
    expect(bad).toEqual([]);
  });
  it("action files export at least one action each", () => {
    expect(actionFiles.filter((a) => exportedFunctions(a.file, strip(a.src)).names.length === 0).map((a) => a.file)).toEqual([]);
  });
});

describe("the tripwire itself catches the mistakes it exists for", () => {
  const run = (src: string, fn = "doIt", allow?: { reason: string; own?: Own }) => { const code = strip(src); return check("app/x/actions.ts", fn, code, localFunctions(code), allow); };

  it("passes a guarded action, including a guard inside a same-file helper", () => {
    expect(run(`export async function doIt() { await requireRole(["admin"]); const r = await sb.from("t").select(); }`)).toEqual([]);
    expect(run(`async function load() { await requireRole(["admin"]); }\nexport async function doIt(): Promise<{ ok: true }> { await load(); await sb.rpc("x"); }`)).toEqual([]);
  });
  it("flags an unguarded action and names the file", () => {
    const v = run(`export async function doIt() { return 1; }`);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("app/x/actions.ts (doIt)");
    expect(v[0]).toContain("no requireRole");
  });
  it("flags data read before the guard", () => {
    expect(run(`export async function doIt() { const { data } = await sb.from("patients").select(); await requireRole(["admin"]); }`)[0]).toContain("BEFORE");
    expect(run(`async function load() { await sb.rpc("x"); }\nexport async function doIt() { await load(); await requireRole(["admin"]); }`)[0]).toContain("BEFORE");
  });
  it("does not count a guard that is only mentioned in a comment or a string", () => {
    expect(run(`export async function doIt() { // requireRole(["admin"])\n /* requireUser( */ const s = "requireRole("; const t = \`requireUser(\`; await sb.from("t"); }`)[0]).toBeDefined();
  });
  it("reads past braces in the return type and in destructured parameters", () => {
    expect(run(`export async function doIt({ a, b }: { a: string; b: number }): Promise<{ ok: boolean; why?: string } | null> { await requireUser(); }`)).toEqual([]);
    expect(run(`export async function doIt({ a }: { a: string }): Promise<{ ok: boolean }> { await sb.from("t"); }`)).toHaveLength(1);
  });
  it("refuses a function it cannot read instead of passing it", () => {
    expect(run(`export const doIt = async () => { await sb.from("t"); }`)[0]).toContain("cannot find the function body");
    expect(exportedFunctions("f.ts", strip(`export const doIt = async (x: number) => { return x; }`)).problems).toHaveLength(1);
    expect(exportedFunctions("f.ts", strip(`export { a, b } from "./z";`)).problems).toHaveLength(1);
  });
  it("self-authenticating entries must really call their check, before the data", () => {
    const own = { reason: "cron", own: { auth: /\bbearerMatches\(/, before: /\bserviceRpc\(/ } };
    expect(run(`export async function doIt() { if (!bearerMatches(h)) return 1; serviceRpc(); }`, "doIt", own)).toEqual([]);
    expect(run(`export async function doIt() { serviceRpc(); bearerMatches(h); }`, "doIt", own)[0]).toContain("before");
    expect(run(`export async function doIt() { serviceRpc(); }`, "doIt", own)[0]).toContain("not called");
  });
  it("copes with template literals containing braces, quotes and nested templates", () => {
    expect(strip("const a = `x ${ y ? `n${z}` : '}' } {`; const b = 1;")).toMatch(/const b = 1;/);
    const s = strip("function f() { const u = `${base}/a?{b}`; return 'it\\'s'; }");
    expect((s.match(/\{/g) ?? []).length).toBe((s.match(/\}/g) ?? []).length);
  });
});
