import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Every environment variable the code reads must be documented in .env.example (name, what it is for, whether it is secret).
const root = join(__dirname, "..", "..");
const example = readFileSync(join(root, ".env.example"), "utf8");
const documented = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

/** Set by the platform or the runtime, not by the owner. */
const PLATFORM = new Set(["NODE_ENV", "NEXT_RUNTIME", "CI", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "TEST_WORKER_INDEX", "PORT", "npm_config_script_shell"]);

function files(dir: string, ext = /\.(ts|tsx|mjs)$/): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next" || name === ".auth") continue;
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** process.env.X, process.env["X"], destructuring from process.env, env.X (a parameter named env) and the string-argument helpers has("X") / required("X") */
function envNames(src: string): string[] {
  const code = strip(src);
  const names = new Set<string>();
  for (const m of code.matchAll(/\{([^}]*)\}\s*=\s*(?:process\.)?env\b/g))
    for (const part of m[1].split(",")) { const n = part.trim().split(/[\s:=]/)[0]; if (/^[A-Z][A-Z0-9_]+$/.test(n)) names.add(n); }
  for (const re of [/process\.env\.([A-Z][A-Z0-9_]+)/g, /process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g, /\benv\.([A-Z][A-Z0-9_]+)/g, /\b(?:has|required)\(\s*["']([A-Z][A-Z0-9_]+)["']\s*\)/g])
    for (const m of code.matchAll(re)) names.add(m[1]);
  return [...names];
}

describe(".env.example", () => {
  it("documents every variable the app code and scripts read (app/, lib/, components/, scripts/, middleware.ts, next.config.ts)", () => {
    const sources = [...files(join(root, "app")), ...files(join(root, "lib")), ...files(join(root, "components")), ...files(join(root, "scripts")), join(root, "middleware.ts"), join(root, "next.config.ts")];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const f of sources) for (const n of envNames(readFileSync(f, "utf8"))) {
      seen.add(n);
      if (!PLATFORM.has(n) && !documented.has(n)) missing.push(`${n} (${relative(root, f)})`);
    }
    expect(missing).toEqual([]);
    // sanity: the scanner really sees the known variables, so an empty result cannot mean "found nothing"
    for (const n of ["APP_URL", "CRON_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PAYFAST_MERCHANT_KEY", "EMAIL_API_KEY", "EMAIL_FROM", "SMS_ACTIVE", "PAYFAST_SANDBOX"]) expect(seen.has(n), n).toBe(true);
  });

  it("documents the end-to-end variables used by the Playwright config and specs (except those global setup derives itself)", () => {
    const setup = readFileSync(join(root, "tests", "e2e", "global-setup.ts"), "utf8");
    const derived = new Set([...setup.matchAll(/set\(\s*"(E2E_[A-Z0-9_]+)"/g)].map((m) => m[1]));
    const sources = [...files(join(root, "tests", "e2e")), join(root, "playwright.config.ts")];
    const missing: string[] = [];
    for (const f of sources) for (const n of envNames(readFileSync(f, "utf8"))) {
      if (n.startsWith("E2E_") && !derived.has(n) && !documented.has(n)) missing.push(`${n} (${relative(root, f)})`);
    }
    expect(missing).toEqual([]);
  });

  it("lists no secret value: every assignment is empty or a harmless local default", () => {
    const filled = [...example.matchAll(/^([A-Z][A-Z0-9_]+)=(.+)$/gm)].map((m) => `${m[1]}=${m[2]}`);
    expect(filled.sort()).toEqual(["APP_URL=http://localhost:3000", "PAYFAST_SANDBOX=true"]);
  });

  it("the scanner finds a variable that is not documented (self-test)", () => {
    expect(envNames(`const a = process.env.MY_NEW_SECRET; const b = process.env["OTHER_ONE"]; if (env.THIRD_ONE) {}; required("FOURTH_ONE")`).sort())
      .toEqual(["FOURTH_ONE", "MY_NEW_SECRET", "OTHER_ONE", "THIRD_ONE"]);
    expect(envNames("const { ALPHA, BETA: b, GAMMA = 'x', lower } = process.env; const { DELTA } = env;").sort()).toEqual(["ALPHA", "BETA", "DELTA", "GAMMA"]);
    expect(envNames(`// process.env.COMMENTED\n/* env.BLOCK */`)).toEqual([]);
  });
});
