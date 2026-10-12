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

it("audit calls in the note code carry an action, an entity and an id only (no detail argument)", () => {
  const calls = noteFiles.flatMap((f) => [...read(f).matchAll(/\baudit\(([^)]*)\)/g)].map((m) => ({ f: rel(f), args: m[1] })));
  expect(calls.map((c) => c.args)).toEqual(expect.arrayContaining(['"note.view", "clinical_notes", note.id']));
  for (const c of calls) expect(c.args.split(",").length, `${c.f}: ${c.args}`).toBeLessThanOrEqual(3);
});

it("redirects and links carry ids and notice codes only, never text", () => {
  for (const f of noteFiles) {
    const src = read(f);
    for (const m of src.matchAll(/(?:redirect|href=)\(?[`{"]([^`"]*(?:\$\{[^}]*\}[^`"]*)*)/g)) expect(m[1], `${rel(f)}: ${m[1]}`).not.toMatch(/content|risk|text|addendum\W*=|\.notes/i);
  }
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
  expect(rpcs.sort()).toEqual(["add_addendum", "sign_note"]);
  const tables = new Set(noteFiles.flatMap((f) => [...read(f).matchAll(/\.from\("(\w+)"\)/g)].map((m) => m[1])));
  expect([...tables].sort()).toEqual(["appointments", "clinical_notes", "note_addenda", "note_templates", "note_versions", "patients", "profiles", "tasks"]);
});
