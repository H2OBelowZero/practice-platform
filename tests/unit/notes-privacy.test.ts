import { it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Static guard for the most sensitive data in the system (Task 12). Note text, risk notes and addendum text must never reach a URL, a log,
// an audit detail, an outbox payload, an error message or raw HTML, and every note route is psychologist-only. These are source greps: they
// fail when someone adds a console call, an audit detail, a service-client write or raw HTML to the note code.
const root = join(__dirname, "..", "..");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== ".next") sources(p, out); }
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (f: string) => relative(root, f).replaceAll(String.fromCharCode(92), "/");
const read = (f: string) => readFileSync(f, "utf8");

/** the note-handling code: the note pages and actions, the new-note page, the Notes tab and lib/notes */
const noteFiles = [
  ...sources(join(root, "app", "app", "notes")),
  ...sources(join(root, "app", "app", "patients", "[id]", "notes")),
  join(root, "app", "app", "patients", "[id]", "tab-notes.tsx"),
  ...sources(join(root, "lib", "notes")),
];
const pages = noteFiles.filter((f) => rel(f).endsWith("/page.tsx"));
const actions = join(root, "app", "app", "notes", "actions.ts");

it("finds the note code it is meant to guard", () => {
  expect(noteFiles.length).toBeGreaterThanOrEqual(12);
  expect(pages.map(rel)).toEqual(expect.arrayContaining(["app/app/notes/[noteId]/page.tsx", "app/app/patients/[id]/notes/new/page.tsx"]));
});

it("no console.* call anywhere in the note code (nothing to log: note text must not reach server or browser logs)", () => {
  for (const f of noteFiles) expect(read(f), rel(f)).not.toMatch(/\bconsole\s*\./);
});

it("no dangerouslySetInnerHTML anywhere in app/ or lib/ (note text is only ever rendered as React text)", () => {
  for (const f of [...sources(join(root, "app")), ...sources(join(root, "lib")), ...sources(join(root, "components"))]) expect(read(f), rel(f)).not.toMatch(/dangerouslySetInnerHTML/);
});

it("every note page and every exported action calls requireRole([\"psychologist\"]) itself (R26)", () => {
  for (const f of pages) expect(read(f), rel(f)).toMatch(/requireRole\(\["psychologist"\]\)/);
  const src = read(actions);
  const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  expect(exported.sort()).toEqual(["addAddendum", "createNote", "loadNoteVersion", "saveNoteDraft", "signNote"]);
  for (const name of exported) {
    const body = src.slice(src.indexOf(`export async function ${name}`)).split(/\nexport /)[0];
    expect(body, name).toMatch(/await requireRole\(\[\.\.\.PSY\]\)/);
  }
  expect(src).toMatch(/const PSY = \["psychologist"\] as const/);
});

it("page titles are fixed text (no patient name, no generateMetadata)", () => {
  for (const f of pages) {
    const src = read(f);
    expect(src, rel(f)).toMatch(/export const metadata = \{ title: "[^"$`]+" \}/);
    expect(src, rel(f)).not.toMatch(/generateMetadata/);
  }
});

/** the text of every call to `name(` in `src`, as its top-level arguments (parentheses, braces, brackets and quotes balanced) */
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

it("the argument scanner handles nesting and quotes", () => {
  expect(callArgs(`x audit("a,b", "c", f(1, 2), { p: [1, 2], q: "}" })`, "audit")).toEqual([["\"a,b\"", "\"c\"", "f(1, 2)", "{ p: [1, 2], q: \"}\" }"]]);
});

it("audit calls in the note code carry an action, an entity, an id and at most a detail of ids (patient_id, version flag): never text", () => {
  const calls = noteFiles.flatMap((f) => callArgs(read(f), "audit").map((args) => ({ f: rel(f), args })));
  expect(calls.map((c) => c.args.slice(0, 3).join(", "))).toEqual(expect.arrayContaining(["\"note.view\", \"clinical_notes\", note.id", "\"note.create\", \"clinical_notes\", data.id as string"]));
  expect(calls.length).toBeGreaterThanOrEqual(3);
  for (const c of calls) {
    expect(c.args.length, `${c.f}: ${c.args.join(" | ")}`).toBeLessThanOrEqual(4);
    if (c.args[3]) expect(c.args[3].replace(/\s+/g, " "), c.f).toMatch(/^\{ patient_id: [\w.]+(, version: true)? \}$/);
  }
});

it("redirects, router pushes, location changes and links carry ids and notice codes only: no template placeholder names note text, risk, an addendum or a form value", () => {
  const files = [...noteFiles, join(root, "app", "app", "calendar", "[id]", "page.tsx")];
  const sinks = ["redirect", "router.push", "router.replace", "location.assign", "location.replace", "new URL", "hrefWith"];
  const bad = /content|risk|notes\b|text|addendum|value|body|answer/i;
  const placeholders = (s: string) => [...s.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  for (const f of files) {
    const src = read(f);
    for (const name of sinks) for (const args of callArgs(src, name)) for (const p of placeholders(args.join(","))) expect(p, `${rel(f)} ${name}`).not.toMatch(bad);
    for (const m of src.matchAll(/(?:href|location\.href)\s*=\s*\{?`([^`]*)`/g)) for (const p of placeholders(m[1])) expect(p, `${rel(f)} href`).not.toMatch(bad);
  }
  expect(callArgs(read(actions), "redirect").length).toBeGreaterThanOrEqual(4); // the scan really finds the action redirects
});

it("the note code never uses the service client or the outbox (nothing clinical is queued or written outside RLS)", () => {
  for (const f of noteFiles) {
    const src = read(f);
    expect(src, rel(f)).not.toMatch(/supabaseService|notifications_outbox/);
  }
});

it("the Clinical notes tab is for the psychologist only and the calendar link is psychologist-only", () => {
  expect(read(join(root, "app", "app", "patients", "[id]", "tabs.ts"))).toMatch(/key: "notes", label: "Clinical notes", roles: \["psychologist"\]/);
  expect(read(join(root, "app", "app", "calendar", "[id]", "page.tsx"))).toMatch(/st === "attended" && me\.role === "psychologist"/);
});

it("database calls the note code makes are the ones audited in the Task 12 report (R34)", () => {
  const rpcs = noteFiles.flatMap((f) => [...read(f).matchAll(/\.rpc\(\s*"(\w+)"/g)].map((m) => m[1]));
  expect(rpcs.sort()).toEqual(["add_addendum", "raise_risk_task", "sign_note"]);
  const tables = new Set(noteFiles.flatMap((f) => [...read(f).matchAll(/\.from\("(\w+)"\)/g)].map((m) => m[1])));
  expect([...tables].sort()).toEqual(["appointments", "clinical_notes", "note_addenda", "note_templates", "note_versions", "patients", "profiles"]);
});
