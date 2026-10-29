import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Static authorisation tripwire (R26: middleware and layouts are NOT authorisation).
 *
 * Every page.tsx, every route.ts handler and every exported server action (any form: declaration, const arrow/function, wrapper call, local re-export) must either
 *   - be in an explicit allow-list below, with a reason (public, or authenticated by its own mechanism), or
 *   - call requireRole( / requireUser( / requireRecoverySession( UNCONDITIONALLY and AWAITED (or returned) at the top level of its body (not inside if/&&/?:/callbacks), BEFORE its first data access.
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
  "app/about/page.tsx": { reason: "public marketing page, static content" },
  "app/practices/page.tsx": { reason: "public marketing page, static content" },
  "app/contact/page.tsx": { reason: "public marketing page, static content" },
  "app/blog/page.tsx": { reason: "public marketing page, static content" },
  "app/blog/[slug]/page.tsx": { reason: "public blog post, static content" },
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


// Server-action files that exist today. Adding one (or removing one) must be acknowledged here, so a new action file cannot slip in unreviewed.
const EXPECTED_ACTION_FILES = [
  "app/(auth)/actions.ts",
  "app/(public)/book/actions.ts",
  "app/app/billing/actions.ts",
  "app/app/calendar/actions.ts",
  "app/app/claims/actions.ts",
  "app/app/notes/actions.ts",
  "app/app/patients/[id]/forms/actions.ts",
  "app/app/patients/actions.ts",
  "app/app/settings/actions.ts",
  "app/app/tasks/actions.ts",
  "app/portal/appointments/actions.ts",
  "app/portal/documents/actions.ts",
  "app/portal/payments/actions.ts",
  "app/portal/privacy/actions.ts",
  "app/portal/settings/actions.ts",
];
// A function-level "use server" directive inside any other file hides an action from the per-file reasoning. None exist; list a file here (with a reason) to allow one.
const INLINE_USE_SERVER: Record<string, string> = {};

// ---- the analyser (plain functions so the self-tests below can feed it fabricated sources) ----
const GUARD = /\b(?:requireRole|requireUser|requireRecoverySession)\(/g;
const DATA = /\.from\(|\.rpc\(|\bgetPractice\(|\bgetCrisisText\(|\baudit\(/g;
const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
type Allow = { reason: string; own?: Own };

/** Blank out comments and string/template contents (keeping code inside `${}`), preserving length and newlines. `keepStrings` leaves string text in place (comments are still blanked). */
function strip(src: string, keepStrings = false): string {
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
        const inner = src.slice(i + 1, j);
        out += c + (keepStrings ? inner : " ".repeat(inner.length)) + (src[j] === c ? c : ""); i = src[j] === c ? j + 1 : j; continue;
      }
      if (c === "`") {
        out += "`"; i++;
        while (i < src.length && src[i] !== "`") {
          if (src[i] === "\\") { out += keepStrings ? src.slice(i, i + 2) : "  "; i += 2; continue; }
          if (src[i] === "$" && src[i + 1] === "{") { const [inner, k] = scan(i + 2, true); out += "${" + inner + "}"; i = k + 1; continue; }
          out += src[i] === "\n" ? "\n" : keepStrings ? src[i] : " "; i++;
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

/** Text inside the brace block that starts at `text[from]` (which must be `{`), or null. */
function braceInner(text: string, from: number): string | null {
  let depth = 0;
  for (let i = from; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) return text.slice(from + 1, i); }
  return null;
}
/** Index just after the `)` that closes the `(` at `text[from]`, or -1. */
function parenEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) { if (text[i] === "(") depth++; else if (text[i] === ")" && --depth === 0) return i + 1; }
  return -1;
}
/** Body of a function whose parameter list starts at the first `(` at or after `from`: skips the return type (it may hold braces, e.g. Promise<{ ok: true }>). */
function bodyAfterParams(text: string, from: number): string | null {
  const open = text.indexOf("(", from);
  if (open < 0) return null;
  let i = parenEnd(text, open);
  if (i < 0) return null;
  let angle = 0;
  for (; i < text.length; i++) {
    if (text[i] === "<") angle++; else if (text[i] === ">" && text[i - 1] !== "=") angle--;
    else if (text[i] === "{" && angle <= 0) return braceInner(text, i);
  }
  return null;
}

type Fn = { body: string; async: boolean; expr?: boolean };
type Alias = { alias: string };

/** Where a `const x = <expression>` expression ends: `;`, a line break that is not a continuation, or the block that encloses it closing. */
function exprEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) { if (depth === 0) return i; depth--; }
    else if (c === ";" && depth === 0) return i;
    else if (c === "\n" && depth === 0) {
      const before = code.slice(from, i).trimEnd().slice(-1), after = code.slice(i).trimStart()[0] ?? "";
      if (before && !"=>(,.?:&|+".includes(before) && !".?:&|+".includes(after)) return i;
    }
  }
  return code.length;
}

/** A function expression, arrow function (block or expression body) or wrapper call around one (`wrap(async () => {...})`); or a bare identifier (alias). */
function fnFromExpr(expr: string): Fn | Alias | null {
  const t = expr.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return { alias: t };
  const arrow = expr.indexOf("=>"); const kw = expr.search(/\bfunction\b/);
  if (arrow >= 0 && (kw < 0 || arrow < kw)) {
    const rest = expr.slice(arrow + 2).trimStart();
    const body = rest[0] === "{" ? braceInner(rest, 0) : rest;
    return body === null ? null : { body, async: /\basync\b/.test(expr.slice(0, arrow)), expr: rest[0] !== "{" };
  }
  if (kw >= 0) { const body = bodyAfterParams(expr, kw); return body === null ? null : { body, async: /\basync\b/.test(expr.slice(0, kw)) }; }
  return null;
}

/** Every function this file declares at any level: `function f() {}` and `const f = <function-like>`. Alias consts (`const GET = run`) map to the target's name. */
function localFunctions(code: string): Map<string, Fn | Alias> {
  const fns = new Map<string, Fn | Alias>();
  for (const m of code.matchAll(/(?:^|[\s;}])(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
    const body = bodyAfterParams(code, m.index! + m[0].length);
    if (body !== null) fns.set(m[2], { body, async: !!m[1] });
  }
  for (const m of code.matchAll(/(?:^|[\s;}])(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*/g)) {
    const f = fnFromExpr(code.slice(m.index! + m[0].length, exprEnd(code, m.index! + m[0].length)));
    if (f) fns.set(m[1], f);
  }
  return fns;
}
const isFn = (f: Fn | Alias | undefined): f is Fn => !!f && "body" in f;
/** Follow `const GET = run` aliases (also `export { run as GET }`) to the function that really runs. */
function resolveFn(table: Map<string, Fn | Alias>, name: string): { key: string; fn: Fn } | null {
  let key = name; const seen = new Set<string>();
  for (;;) {
    const f = table.get(key);
    if (isFn(f)) return { key, fn: f };
    if (!f || seen.has(key)) return null;
    seen.add(key); key = f.alias;
  }
}

type Exp = { name: string; local: string; kind: "function" | "var" | "value" | "reexport" | "reexport-from" | "star" };
/** Every runtime export of a (stripped) source. Type-only exports are erased at build time and ignored. */
function listExports(code: string): Exp[] {
  const out: Exp[] = [];
  for (const m of code.matchAll(/\bexport\s+(default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?/g)) out.push({ name: m[2] ?? "default", local: m[2] ?? "default", kind: "function" });
  for (const m of code.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.push({ name: m[1], local: m[1], kind: "var" });
  for (const m of code.matchAll(/\bexport\s+(?:abstract\s+)?(?:enum|class|namespace)\s+([A-Za-z_$][\w$]*)/g)) out.push({ name: m[1], local: m[1], kind: "value" });
  if (/\bexport\s+default\s+(?!(?:async\s+)?function\b)/.test(code)) out.push({ name: "default", local: "default", kind: "value" });
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}(\s*from\b)?/g)) {
    for (const spec of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      const [local, exported] = spec.replace(/^type\s+/, "").split(/\s+as\s+/);
      if (/^type\s/.test(spec)) continue;
      out.push({ name: exported ?? local, local, kind: m[2] ? "reexport-from" : "reexport" });
    }
  }
  if (/\bexport\s*\*/.test(code)) out.push({ name: "*", local: "*", kind: "star" });
  return out;
}

/** Is the statement that holds the call at `at` run unconditionally, at the top level of `body`? A guard inside if/else, `&&`, `?:`, a callback or a loop does not count. */
const PREFIX_OK = /^\s*(?:(?:const|let|var)\s+(?:[\w$]+|\{[^}]*\}|\[[^\]]*\])\s*(?::[^=]+)?=\s*)?\(?\s*(?:return\s+|await\s+)(?:await\s+)?(?:Promise\.all\(\s*\[\s*)?\(?\s*$/;
function unconditionalAt(body: string, at: number, exprBody = false): boolean {
  let brace = 0, paren = 0, bracket = 0, start = 0;
  for (let i = 0; i < at; i++) {
    const c = body[i], flat = () => brace === 0 && paren === 0 && bracket === 0;
    if (c === "{") brace++;
    else if (c === "}") { brace--; if (flat() && !/^\s*(?:[=.,)?:(\]]|else\b|catch\b|finally\b)/.test(body.slice(i + 1, i + 40))) start = i + 1; }
    else if (c === "(") paren++; else if (c === ")") paren--;
    else if (c === "[") bracket++; else if (c === "]") bracket--;
    else if (c === ";" && flat()) start = i + 1;
  }
  const prefix = body.slice(start, at);
  // the guard must be AWAITED (or returned): a bare `requireRole(...)` is a floating promise that nothing waits for, so the page would run on regardless
  return brace === 0 && (PREFIX_OK.test(prefix) || (exprBody && prefix.trim() === ""));
}

type Event = "guard" | "data" | "conditional" | "none";
/** What happens first when `name` runs: an unconditional guard, a data access, only conditional guards, or nothing. Follows calls to functions declared in the same file. */
function firstEvent(name: string, table: Map<string, Fn | Alias>, seen = new Set<string>()): Event {
  const r = resolveFn(table, name);
  if (!r || seen.has(r.key)) return "none";
  seen.add(r.key);
  const body = r.fn.body;
  const events: { at: number; kind: string }[] = [];
  for (const m of body.matchAll(GUARD)) events.push({ at: m.index!, kind: "guard" });
  for (const m of body.matchAll(DATA)) events.push({ at: m.index!, kind: "data" });
  for (const other of table.keys()) if (other !== name && other !== r.key) for (const m of body.matchAll(new RegExp(`(?<![\\w$.])${other.replace(/\$/g, "\\$")}\\(`, "g"))) events.push({ at: m.index!, kind: other });
  events.sort((a, b) => a.at - b.at);
  let conditional = false;
  for (const e of events) {
    const kind = e.kind === "guard" || e.kind === "data" ? e.kind : firstEvent(e.kind, table, seen);
    if (kind === "data") return "data";
    if (kind === "guard") { if (unconditionalAt(body, e.at, r.fn.expr)) return "guard"; conditional = true; }
    else if (kind === "conditional") conditional = true;
  }
  return conditional ? "conditional" : "none";
}

/** Violations for one function: empty when it is allowed, or guarded unconditionally before its first data access. */
function check(label: string, name: string, table: Map<string, Fn | Alias>, allow?: Allow): string[] {
  const r = resolveFn(table, name);
  if (!r) return [`${label}: cannot read this function: use \`export async function\` or \`export const x = async () => {...}\` so the tripwire can see its body`];
  if (allow) {
    if (!allow.own) return [];
    const at = r.fn.body.search(allow.own.auth);
    if (at < 0) return [`${label}: allow-listed as self-authenticating but ${allow.own.auth} is not called`];
    const data = allow.own.before ? r.fn.body.search(allow.own.before) : -1;
    return data >= 0 && data < at ? [`${label}: reaches ${allow.own.before} before ${allow.own.auth}`] : [];
  }
  switch (firstEvent(name, table)) {
    case "guard": return [];
    case "data": return [`${label}: reads data BEFORE an unconditional requireRole/requireUser/requireRecoverySession call`];
    case "conditional": return [`${label}: the guard is conditional (inside if/else, &&, ?:, a loop or a callback): it must run unconditionally at the top level of the function`];
    default: return [`${label}: no requireRole/requireUser/requireRecoverySession call (add one, or add it to the allow-list in authz-coverage.test.ts with a reason)`];
  }
}


/** The file-level `"use server"` directive (first statement, trailing comments allowed). */
function hasUseServerDirective(src: string): boolean { return /^\s*["']use server["']/.test(strip(src, true)); }
/** Lines of function-level (or otherwise misplaced) "use server" directives: every occurrence except the file-level one. */
function inlineUseServer(src: string): number[] {
  const kept = strip(src, true);
  const fileLevel = /^\s*["']use server["']/.exec(kept);
  const lines: number[] = [];
  for (const m of kept.matchAll(/["']use server["']/g)) if (!(fileLevel && m.index === fileLevel[0].length - m[0].length)) lines.push(kept.slice(0, m.index).split("\n").length);
  return lines;
}

function analyseAction(file: string, src: string, allow: Record<string, Allow> = PUBLIC_ACTIONS): string[] {
  const code = strip(src), table = localFunctions(code), out: string[] = [];
  const exps = listExports(code);
  if (exps.length === 0) return [`${file}: a "use server" file that exports nothing`];
  for (const e of exps) {
    const label = `${file} (${e.name})`;
    if (e.kind === "star" || e.kind === "reexport-from") { out.push(`${label}: re-exported from another module: the tripwire cannot follow it`); continue; }
    if (e.kind === "value") { out.push(`${label}: a "use server" file may only export async functions; this is some other value`); continue; }
    const r = resolveFn(table, e.local);
    if (!r) { out.push(`${label}: exported value is not a recognisable async function (declaration, \`= async () => {}\`, \`= async function () {}\` or a wrapper around one)`); continue; }
    if (!r.fn.async) { out.push(`${label}: exported function is not async`); continue; }
    out.push(...check(label, e.local, table, allow[`${file}#${e.name}`]));
  }
  return out;
}

function analysePage(file: string, src: string, allow: Record<string, Allow> = PUBLIC_PAGES): string[] {
  const code = strip(src), table = localFunctions(code);
  const def = /\bexport\s+default\s+(?:async\s+)?function\s*([A-Za-z_$][\w$]*)/.exec(code)?.[1];
  if (!def) return [`${file}: no \`export default [async] function Name\` page component`];
  return check(`${file} (${def})`, def, table, allow[file]);
}

function analyseRoute(file: string, src: string, allow: Record<string, Allow> = PUBLIC_ROUTES): string[] {
  const code = strip(src), table = localFunctions(code), out: string[] = [];
  const handlers = listExports(code).filter((e) => HTTP.includes(e.name));
  if (listExports(code).some((e) => e.kind === "star")) out.push(`${file}: \`export *\` hides handlers from the tripwire`);
  if (handlers.length === 0 && out.length === 0) return [`${file}: exports no HTTP handler`];
  for (const e of handlers) {
    const label = `${file} ${e.name}`;
    if (e.kind === "reexport-from") { out.push(`${label}: re-exported from another module: the tripwire cannot follow it`); continue; }
    out.push(...check(label, e.local, table, allow[`${file}#${e.name}`]));
  }
  return out;
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
const actionFiles = files.filter((f) => hasUseServerDirective(f.src));

describe("authorisation tripwire: coverage of what exists", () => {
  it("finds the pages and routes (the walk is not vacuous)", () => {
    expect(pages.length).toBeGreaterThan(40);
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });
  it("the set of server-action files is exactly the acknowledged list", () => {
    expect(actionFiles.map((f) => f.file).sort()).toEqual([...EXPECTED_ACTION_FILES].sort());
  });
  it("no function-level or misplaced \"use server\" directive anywhere (unless allow-listed)", () => {
    const bad = files.filter((f) => !(f.file in INLINE_USE_SERVER)).flatMap((f) => inlineUseServer(f.src).map((line) => `${f.file}:${line}: "use server" directive that is not the file-level one: move the action into an actions.ts file or allow-list the file with a reason`));
    expect(bad).toEqual([]);
    expect(Object.keys(INLINE_USE_SERVER).filter((k) => !files.some((f) => f.file === k))).toEqual([]);
  });
  it("the stripper keeps braces balanced in every file (otherwise function bodies would be mis-read)", () => {
    const bad = files.filter((f) => { const s = strip(f.src); return (s.match(/\{/g) ?? []).length !== (s.match(/\}/g) ?? []).length; }).map((f) => f.file);
    expect(bad).toEqual([]);
  });
  it("allow-list entries still exist (no stale exemptions)", () => {
    const exportsOf = (list: typeof files, file: string) => listExports(strip(list.find((x) => x.file === file)?.src ?? "")).map((e) => e.name);
    const stale = [
      ...Object.keys(PUBLIC_PAGES).filter((k) => !pages.some((p) => p.file === k)),
      ...Object.keys(PUBLIC_ROUTES).filter((k) => !exportsOf(routes, k.split("#")[0]).includes(k.split("#")[1])),
      ...Object.keys(PUBLIC_ACTIONS).filter((k) => !exportsOf(actionFiles, k.split("#")[0]).includes(k.split("#")[1])),
    ];
    expect(stale).toEqual([]);
  });
});

describe("authorisation tripwire: pages", () => {
  it("every page is public-by-allow-list or guards before reading data", () => {
    expect(pages.flatMap((p) => analysePage(p.file, p.src))).toEqual([]);
  });
});

describe("authorisation tripwire: route handlers", () => {
  it("every exported HTTP handler is guarded or allow-listed with its own auth", () => {
    expect(routes.flatMap((r) => analyseRoute(r.file, r.src))).toEqual([]);
  });
});

describe("authorisation tripwire: server actions", () => {
  it("every exported action guards unconditionally before reading data, or is allow-listed", () => {
    expect(actionFiles.flatMap((a) => analyseAction(a.file, a.src))).toEqual([]);
  });
});

describe("the tripwire itself catches the mistakes it exists for", () => {
  const action = (body: string, allow: Record<string, Allow> = {}) => analyseAction("app/x/actions.ts", `"use server";\n${body}`, allow);
  const fails = (v: string[], text: RegExp) => { expect(v).toHaveLength(1); expect(v[0]).toContain("app/x/actions.ts"); expect(v[0]).toMatch(text); };

  it("passes guarded actions in every supported form", () => {
    expect(action(`export async function doIt() { await requireRole(["admin"]); await sb.from("t"); }`)).toEqual([]);
    expect(action(`export const doIt = async () => { await requireRole(["admin"]); await sb.from("t"); };`)).toEqual([]);
    expect(action(`export const doIt = async (x: number): Promise<{ ok: boolean }> => {\n  const me = await requireRole(["admin"]);\n  await sb.from("t");\n};`)).toEqual([]);
    expect(action(`export const doIt = async function (x: number) { const { userId } = await requireUser(); await sb.rpc("t"); };`)).toEqual([]);
    expect(action(`export const doIt = wrap(async () => { await requireRole(["admin"]); await sb.from("t"); });`)).toEqual([]);
    expect(action(`export const doIt = async () => requireRole(["admin"]);`)).toEqual([]);
    expect(action(`async function load() { await requireRole(["admin"]); }\nexport async function doIt(): Promise<{ ok: true }> { await load(); await sb.rpc("x"); }`)).toEqual([]);
    expect(action(`export async function doIt() { const [me, p] = await Promise.all([requireRole(["admin"]), getPractice()]); }`)).toEqual([]);
  });
  it("flags an unguarded action and names the file", () => {
    fails(action(`export async function doIt() { return 1; }`), /no requireRole/);
    fails(action(`export const doIt = async () => { return 1; };`), /no requireRole/);
    fails(action(`export const doIt = async function () { return 1; };`), /no requireRole/);
    fails(action(`export const doIt = wrap(async () => { await sb.from("t"); });`), /BEFORE|no requireRole/);
  });
  it("flags data read before the guard", () => {
    fails(action(`export async function doIt() { const { data } = await sb.from("patients").select(); await requireRole(["admin"]); }`), /BEFORE/);
    fails(action(`async function load() { await sb.rpc("x"); }\nexport async function doIt() { await load(); await requireRole(["admin"]); }`), /BEFORE/);
  });
  it("requires the guard to be awaited or returned: a floating requireRole(...) fails", () => {
    fails(action(`export async function doIt() { requireRole(["admin"]); await sb.from("t"); }`), /no requireRole|BEFORE|conditional/);
    fails(action(`export async function doIt() { requireRole(["admin"]);\n return 1; }`), /no requireRole|conditional/);
    fails(action(`export async function doIt() { const me = requireRole(["admin"]); await sb.from("t"); }`), /no requireRole|BEFORE|conditional/);
    fails(action(`export async function doIt() { void requireRole(["admin"]); await sb.from("t"); }`), /no requireRole|BEFORE|conditional/);
    fails(action(`export async function doIt() { Promise.all([requireRole(["admin"]), getPractice()]); await sb.from("t"); }`), /no requireRole|BEFORE|conditional/);
    fails(action(`async function load() { requireUser(); }\nexport async function doIt() { await load(); await sb.rpc("x"); }`), /no requireRole|BEFORE|conditional/);
    // awaited / returned forms still pass
    expect(action(`export async function doIt() { await requireRole(["admin"]); await sb.from("t"); }`)).toEqual([]);
    expect(action(`export async function doIt() { const me = await requireUser(); await sb.from("t"); }`)).toEqual([]);
    expect(action(`export async function doIt() { return await requireRole(["admin"]); }`)).toEqual([]);
    expect(action(`export async function doIt() { return requireRole(["admin"]); }`)).toEqual([]);
    expect(action(`export async function doIt() { await Promise.all([requireRole(["admin"]), getPractice()]); await sb.from("t"); }`)).toEqual([]);
    expect(action(`export async function doIt() { return Promise.all([requireRole(["admin"]), getPractice()]); }`)).toEqual([]);
  });
  it("flags a guard that is only conditional", () => {
    fails(action(`export async function doIt(x: boolean) { if (x) { await requireRole(["admin"]); } return 1; }`), /conditional/);
    fails(action(`export async function doIt(x: boolean) { if (x) await requireRole(["admin"]);\n return 1; }`), /conditional/);
    fails(action(`export async function doIt(x: boolean) { x && await requireRole(["admin"]); return 1; }`), /conditional/);
    fails(action(`export async function doIt(x: boolean) { const me = x ? await requireRole(["admin"]) : null; return 1; }`), /conditional/);
    fails(action(`export async function doIt(xs: number[]) { xs.forEach(async () => { await requireRole(["admin"]); }); return 1; }`), /conditional/);
    fails(action(`export async function doIt(x: boolean) { try { await requireRole(["admin"]); } catch {} return 1; }`), /conditional/);
    fails(action(`async function load(x: boolean) { if (x) { await requireRole(["admin"]); } }\nexport async function doIt(x: boolean) { await load(x); return 1; }`), /conditional/);
    fails(action(`async function load() { await requireRole(["admin"]); }\nexport async function doIt(x: boolean) { if (x) { await load(); } return 1; }`), /conditional/);
  });
  it("conditional guards followed by data still fail, an unconditional one after them is fine", () => {
    fails(action(`export async function doIt(x: boolean) { if (x) { await requireRole(["a"]); } await sb.from("t"); }`), /BEFORE/);
    expect(action(`export async function doIt(x: boolean) { if (x) { log(); }\n await requireRole(["a"]);\n await sb.from("t"); }`)).toEqual([]);
  });
  it("does not count a guard that is only mentioned in a comment or a string", () => {
    fails(action(`export async function doIt() { // requireRole(["admin"])\n /* requireUser( */ const s = "requireRole("; const t = \`requireUser(\`; await sb.from("t"); }`), /BEFORE|no requireRole/);
  });
  it("reads past braces in the return type and in destructured parameters", () => {
    expect(action(`export async function doIt({ a, b }: { a: string; b: number }): Promise<{ ok: boolean; why?: string } | null> { await requireUser(); }`)).toEqual([]);
    fails(action(`export async function doIt({ a }: { a: string }): Promise<{ ok: boolean }> { await sb.from("t"); }`), /BEFORE|no requireRole/);
  });
  it("refuses exported values that are not async functions, instead of skipping them", () => {
    fails(action(`export const LIMIT = 5;`), /not a recognisable async function|only export async functions/);
    fails(action(`export const doIt = makeAction();`), /not a recognisable async function/);
    fails(action(`export function doIt() { return 1; }`), /not async/);
    fails(action(`export const doIt = () => 1;`), /not async/);
    fails(action(`export enum Kind { A }`), /only export async functions/);
    fails(action(`export default 5;`), /only export async functions/);
    fails(action(`export { a } from "./z";`), /re-exported/);
    fails(action(`export * from "./z";`), /re-exported/);
    expect(action(`export type Foo = { a: string };\nexport interface Bar { b: number }\nexport async function doIt() { await requireUser(); }`)).toEqual([]);
  });
  it("follows a local re-export", () => {
    expect(action(`async function run() { await requireUser(); await sb.from("t"); }\nexport { run as doIt };`)).toEqual([]);
    fails(action(`async function run() { await sb.from("t"); }\nexport { run as doIt };`), /BEFORE|no requireRole/);
  });
  it("honours the allow-list, and a self-authenticating entry must really call its check, before the data", () => {
    expect(action(`export async function doIt() { return 1; }`, { "app/x/actions.ts#doIt": { reason: "public" } })).toEqual([]);
    const own = { reason: "cron", own: { auth: /\bbearerMatches\(/, before: /\bserviceRpc\(/ } };
    expect(action(`export async function doIt() { if (!bearerMatches(h)) return 1; serviceRpc(); }`, { "app/x/actions.ts#doIt": own })).toEqual([]);
    fails(action(`export async function doIt() { serviceRpc(); bearerMatches(h); }`, { "app/x/actions.ts#doIt": own }), /before/);
    fails(action(`export async function doIt() { serviceRpc(); }`, { "app/x/actions.ts#doIt": own }), /not called/);
  });

  describe("pages and routes", () => {
    it("pages: guarded passes, unguarded and conditional fail, naming the file", () => {
      expect(analysePage("app/app/a/page.tsx", `export default async function P() { const me = await requireRole(["admin"]); await sb.from("t"); return null; }`, {})).toEqual([]);
      expect(analysePage("app/app/a/page.tsx", `export default async function P() { await sb.from("t"); }`, {})[0]).toContain("app/app/a/page.tsx (P): reads data BEFORE");
      expect(analysePage("app/app/a/page.tsx", `export default async function P({ searchParams }: { searchParams: Promise<{ a?: string }> }) { if ((await searchParams).a) await requireUser(); }`, {})[0]).toContain("conditional");
      expect(analysePage("app/app/a/page.tsx", `export default function P() { return null; }`, {})[0]).toContain("no requireRole");
      expect(analysePage("app/app/a/page.tsx", `const P = async () => null; export default P;`, {})[0]).toContain("no `export default");
    });
    it("routes: `export { h as POST }`, const handlers and function handlers are all checked", () => {
      const r = (src: string) => analyseRoute("app/api/x/route.ts", src, {});
      expect(r(`async function h() { await requireRole(["admin"]); await sb.rpc("x"); }\nexport { h as POST };`)).toEqual([]);
      expect(r(`async function h() { await sb.rpc("x"); }\nexport { h as POST };`)[0]).toContain("app/api/x/route.ts POST");
      expect(r(`async function run() { await sb.rpc("x"); }\nexport const GET = run;\nexport const POST = run;`)).toHaveLength(2);
      expect(r(`export const GET = async () => { await requireUser(); await sb.from("t"); };`)).toEqual([]);
      expect(r(`export const GET = wrap(async () => { await sb.from("t"); });`)[0]).toContain("GET");
      expect(r(`export const GET = handler;`)[0]).toContain("cannot read");
      expect(r(`export { GET } from "./other";`)[0]).toContain("re-exported");
      expect(r(`export * from "./other";`)[0]).toContain("export *");
      expect(r(`export const dynamic = "force-dynamic";`)[0]).toContain("no HTTP handler");
      expect(r(`export const dynamic = "force-dynamic";\nexport async function GET() { await requireRole(["a"]); await sb.from("t"); }`)).toEqual([]);
    });
  });

  describe("directives", () => {
    it("recognises the file-level directive with a trailing comment, single quotes or a leading comment", () => {
      expect(hasUseServerDirective(`"use server"; // actions\nexport async function a() {}`)).toBe(true);
      expect(hasUseServerDirective(`'use server'\nexport async function a() {}`)).toBe(true);
      expect(hasUseServerDirective(`/* header */\n// more\n"use server";\nexport async function a() {}`)).toBe(true);
      expect(hasUseServerDirective(`"use client";\nexport function a() {}`)).toBe(false);
      expect(hasUseServerDirective(`// "use server" is mentioned here\nexport function a() {}`)).toBe(false);
    });
    it("finds a function-level directive anywhere, and ignores the file-level one and comments", () => {
      expect(inlineUseServer(`"use server";\nexport async function a() {}`)).toEqual([]);
      expect(inlineUseServer(`export default async function P() {\n  async function act() {\n    "use server";\n    await sb.from("t");\n  }\n}`)).toEqual([3]);
      expect(inlineUseServer(`"use server";\nexport async function a() {\n  'use server';\n}`)).toEqual([3]);
      expect(inlineUseServer(`// say "use server" here\n/* "use server" */\nexport function a() {}`)).toEqual([]);
    });
  });

  it("copes with template literals containing braces, quotes and nested templates", () => {
    expect(strip("const a = `x ${ y ? `n${z}` : '}' } {`; const b = 1;")).toMatch(/const b = 1;/);
    const s = strip("function f() { const u = `${base}/a?{b}`; return 'it\\'s'; }");
    expect((s.match(/\{/g) ?? []).length).toBe((s.match(/\}/g) ?? []).length);
  });
});
