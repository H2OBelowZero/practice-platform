import { it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// Regression guard (Task 11b fix round 2): set_consent refuses a patient's or guardian's grant that no submitted form backs
// (consent_needs_submission), so app code must never ask it to grant with a null submission: the booking page once did, and every booking failed.
// Grants go through submit_form (forms) or accept_booking_terms (booking). Withdrawals (granted false) are free.
const root = join(__dirname, "..", "..");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules" && name !== ".next") sources(p, out); }
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const app = [...sources(join(root, "app")), ...sources(join(root, "lib")), ...sources(join(root, "components"))];

/** every `set_consent` call site: the text from the name to the end of its argument object */
function callSites(): { file: string; text: string }[] {
  const found: { file: string; text: string }[] = [];
  for (const file of app) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/rpc\(\s*["']set_consent["']\s*,\s*\{[^}]*\}/g)) found.push({ file: file.slice(root.length + 1), text: m[0] });
  }
  return found;
}

it("app code calls set_consent only to withdraw (p_granted false) - no grant with a null submission", () => {
  const sites = callSites();
  expect(sites.length).toBeGreaterThan(0); // the scan really finds the withdrawal call
  for (const s of sites) {
    expect(/p_granted:\s*false/.test(s.text), `${s.file}: ${s.text}`).toBe(true);
    expect(/p_granted:\s*true/.test(s.text), s.file).toBe(false);
  }
});

it("the booking action records its terms consent through accept_booking_terms", () => {
  const src = readFileSync(join(root, "app", "(public)", "book", "actions.ts"), "utf8");
  expect(src).toMatch(/rpc\(\s*["']accept_booking_terms["']/);
  expect(src).not.toMatch(/set_consent/);
});

it("no other code path invents a consent grant (set_consent named anywhere outside the privacy withdrawal is a prose mention only)", () => {
  const mentions = app.filter((f) => /set_consent/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1).split(sep).join("/"));
  for (const m of mentions) expect(["app/portal/privacy/actions.ts", "lib/forms/errors.ts"], m).toContain(m);
});
