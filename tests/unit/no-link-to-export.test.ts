import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// A download route (CSV export) must be reached by a plain <a href download>, never a next/link <Link> or <LinkButton>: Link prefetches and soft-navigates,
// which would run GET /app/audit/export (an audit row plus up to 5000 rows read) without anyone clicking.
const root = join(__dirname, "..", "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === "node_modules" || n === ".next" ? [] : files(p)) : /\.(tsx|ts)$/.test(n) ? [p] : [];
  });
}
const src = ["app", "components", "lib"].flatMap((d) => files(join(root, d)));

/** every <Link ...> / <LinkButton ...> opening tag in a file (attributes can contain `>` only inside {} expressions, which none of ours do for href) */
const linkTags = (code: string) => [...code.matchAll(/<(?:Link|LinkButton)\b[^>]*>/g)].map((m) => m[0]);

describe("downloads are plain anchors", () => {
  it("no Link or LinkButton points at an /export route, or at a variable named like one", () => {
    const bad: string[] = [];
    for (const f of src) for (const tag of linkTags(readFileSync(f, "utf8"))) if (/export/i.test(tag)) bad.push(`${f}: ${tag}`);
    expect(bad).toEqual([]);
  });
  it("redirect()/router pushes never target an /export route either", () => {
    const bad = src.filter((f) => /(redirect|router\.(push|replace|prefetch))\(\s*[`"'][^`"']*\/export/.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });
  it("the audit export control is an AnchorButton (a real <a download>)", () => {
    const page = readFileSync(join(root, "app", "app", "audit", "page.tsx"), "utf8");
    expect(page).toMatch(/<AnchorButton[^>]*href=\{exportHref\}/);
    const btn = readFileSync(join(root, "components", "ui", "button.tsx"), "utf8");
    expect(btn).toMatch(/export function AnchorButton[\s\S]*<a download/);
    expect(btn.slice(btn.indexOf("export function AnchorButton"))).not.toContain("<Link");
  });
  it("the scanner would catch a bad link (self-check)", () => {
    expect(linkTags('<LinkButton variant="secondary" href={exportHref}>x</LinkButton>').some((t) => /export/i.test(t))).toBe(true);
    expect(linkTags('<Link href="/app/audit/export?a=1">x</Link>').some((t) => /export/i.test(t))).toBe(true);
    expect(linkTags('<Link href="/app/audit">x</Link>').some((t) => /export/i.test(t))).toBe(false);
  });
});
