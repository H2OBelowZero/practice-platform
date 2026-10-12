// CI gate for `npm audit --omit=dev`: fails only on NEW high/critical advisories, i.e. ones not in .github/audit-allowlist.json.
// Moderate/low advisories are printed but never fail. Allow-list entries need { id (GHSA), reason, reviewed (YYYY-MM-DD) }; entries older than
// 90 days and entries that no longer match anything are reported so the list does not rot (also never failing).
// Usage: node scripts/audit-check.mjs [audit.json]   (without an argument it runs `npm audit --json --omit=dev`)
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BLOCKING = new Set(["high", "critical"]);
const MAX_AGE_DAYS = 90;

/** Unique advisories in an `npm audit --json` report. Packages whose `via` is only other package names carry no advisory of their own. */
export function advisories(audit) {
  const found = new Map();
  for (const [pkg, v] of Object.entries(audit?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || via === null) continue;
      const id = /GHSA-[a-z0-9-]+/i.exec(via.url ?? "")?.[0] ?? `npm-${via.source}`;
      found.set(id, { id, severity: String(via.severity ?? "unknown").toLowerCase(), title: via.title ?? "", package: via.name ?? pkg });
    }
  }
  return [...found.values()];
}

/** Pure: decide what fails. `today` is a Date (injectable for tests). */
export function evaluate({ audit, allowlist, today = new Date() }) {
  if (!audit || typeof audit !== "object" || audit.error || !audit.vulnerabilities) throw new Error("npm audit produced no usable report" + (audit?.error?.summary ? `: ${audit.error.summary}` : ""));
  const allowed = new Map((allowlist ?? []).map((e) => [e.id, e]));
  const found = advisories(audit);
  const blocking = [], warnings = [], accepted = [];
  for (const a of found) {
    if (allowed.has(a.id)) accepted.push(a);
    else if (BLOCKING.has(a.severity)) blocking.push(a);
    else warnings.push(a);
  }
  const ids = new Set(found.map((a) => a.id));
  const invalid = (allowlist ?? []).filter((e) => !e.id || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewed ?? "")).map((e) => e.id ?? "(no id)");
  const stale = (allowlist ?? []).filter((e) => e.reviewed && (today - new Date(e.reviewed)) / 86400000 > MAX_AGE_DAYS).map((e) => e.id);
  const unused = (allowlist ?? []).filter((e) => !ids.has(e.id)).map((e) => e.id);
  return { blocking: blocking.concat(invalid.map((id) => ({ id, severity: "invalid", title: "allow-list entry needs id, reason and reviewed (YYYY-MM-DD)", package: "" }))), warnings, accepted, stale, unused };
}

const line = (a) => `  ${a.id} [${a.severity}] ${a.package} ${a.title}`.trimEnd();

function main() {
  const file = process.argv[2];
  let raw;
  if (file) raw = readFileSync(file, "utf8");
  else {
    try { raw = execSync("npm audit --json --omit=dev", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 }); }
    catch (e) { raw = e.stdout; } // npm audit exits non-zero when it finds anything; the report is still on stdout
  }
  const allowlist = JSON.parse(readFileSync(new URL("../.github/audit-allowlist.json", import.meta.url), "utf8"));
  let r;
  try { r = evaluate({ audit: JSON.parse(raw), allowlist }); } catch (e) { console.error(`audit-check: ${e.message}`); process.exit(1); }
  if (r.accepted.length) console.log(`Accepted (allow-listed, see .github/audit-allowlist.json):\n${r.accepted.map(line).join("\n")}`);
  if (r.warnings.length) console.log(`Not allow-listed, below high (does not fail the build):\n${r.warnings.map(line).join("\n")}`);
  if (r.stale.length) console.log(`Allow-list entries last reviewed more than ${MAX_AGE_DAYS} days ago, please re-review: ${r.stale.join(", ")}`);
  if (r.unused.length) console.log(`Allow-list entries that no longer match an advisory (can be removed): ${r.unused.join(", ")}`);
  if (r.blocking.length) { console.error(`NEW high/critical advisories (fix, or review and add to .github/audit-allowlist.json with a reason):\n${r.blocking.map(line).join("\n")}`); process.exit(1); }
  console.log("audit-check: no new high or critical advisories.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
