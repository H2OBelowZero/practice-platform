// Load the ICD-10 code list into icd10_codes (migration 0034, import_icd10_codes). The practice downloads the South African ICD-10 Master Industry
// Table (MIT) itself, from the Council for Medical Schemes' ICD-10 page, saves it as CSV, and runs this script. Nothing is downloaded here.
//
// Usage:
//   node scripts/import-icd10.mjs <file.csv> [--dry-run] [--code-column <name>] [--description-column <name>]
// The CSV needs a header row. By default the code column is the first whose name contains "code" and the description column the first whose name
// contains "desc" (case-insensitive); name them explicitly when the file has several. Comma or semicolon separated, quotes as in RFC 4180, UTF-8
// (a byte-order mark is fine). Codes are trimmed and upper-cased and must look like F32, F32.9 or M54.56; anything else is reported and skipped.
// A code that appears twice is imported once (the first row wins) and reported.
// --dry-run reads and checks the file and prints the summary without touching the database (no environment variables needed).
// Otherwise it needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the service key: run it from your own machine, never from a browser) and
// sends batches of 500. Each batch is all-or-nothing in the database; the summary says how many were inserted, updated or unchanged.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BATCH = 500;
export const CODE_RE = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,2})?$/; // the same rule as import_icd10_codes (0034)
export const MAX_DESCRIPTION = 500;

/** The separator of a header line: semicolon when it has more semicolons than commas (some spreadsheet exports), else comma. */
export function detectDelimiter(headerLine) {
  const count = (ch) => [...headerLine].filter((c) => c === ch).length;
  return count(";") > count(",") ? ";" : ",";
}

/** RFC 4180 CSV: quoted fields may hold the separator, newlines and doubled quotes. Returns rows of raw strings; blank lines are dropped. */
export function parseCsv(text, delimiter) {
  const src = text.replace(/^﻿/, "");
  const sep = delimiter ?? detectDelimiter(src.split(/\r?\n/, 1)[0] ?? "");
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new Error("the file ends inside a quoted field (an opening quote has no closing quote)");
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Index of the code and description columns in the header (explicit names win; otherwise the first containing "code" / "desc"). */
export function pickColumns(header, { codeColumn, descriptionColumn } = {}) {
  const names = header.map((h) => h.trim().toLowerCase());
  const find = (explicit, part) => (explicit ? names.indexOf(explicit.trim().toLowerCase()) : names.findIndex((n) => n.includes(part)));
  const code = find(codeColumn, "code"), description = find(descriptionColumn, "desc");
  if (code < 0) throw new Error(`no code column found in the header (${header.join(", ")}); name it with --code-column`);
  if (description < 0) throw new Error(`no description column found in the header (${header.join(", ")}); name it with --description-column`);
  if (code === description) throw new Error("the code and description columns are the same column");
  return { code, description };
}

/**
 * Check every data row. Returns the codes to import, the rejected rows (with their line number in the file, counting the header as line 1) and the
 * duplicates (later rows of a code already seen). Nothing is thrown for a bad row: the summary lists them.
 */
export function checkRows(rows, cols) {
  const valid = [], invalid = [], duplicates = [];
  const seen = new Set();
  rows.forEach((r, i) => {
    const line = i + 2;
    const code = (r[cols.code] ?? "").trim().toUpperCase();
    const description = (r[cols.description] ?? "").trim();
    if (!CODE_RE.test(code)) { invalid.push({ line, code, reason: "code is not in the form F32, F32.9 or M54.56" }); return; }
    if (description === "" || description.length > MAX_DESCRIPTION) { invalid.push({ line, code, reason: `description must be 1 to ${MAX_DESCRIPTION} characters` }); return; }
    if (seen.has(code)) { duplicates.push({ line, code }); return; }
    seen.add(code);
    valid.push({ code, description });
  });
  return { valid, invalid, duplicates };
}

export const chunks = (items, size = BATCH) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Command-line arguments: the file, --dry-run and the two optional column names. */
export function parseArgs(argv) {
  const out = { file: null, dryRun: false, codeColumn: undefined, descriptionColumn: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--code-column") out.codeColumn = argv[++i];
    else if (a === "--description-column") out.descriptionColumn = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (!out.file) out.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!out.file) throw new Error("usage: node scripts/import-icd10.mjs <file.csv> [--dry-run] [--code-column <name>] [--description-column <name>]");
  return out;
}

/** Read and check a file: everything the summary needs, without the database. */
export function prepare(text, opts = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("the file has no data rows under the header");
  const cols = pickColumns(rows[0], opts);
  return { rows: rows.length - 1, ...checkRows(rows.slice(1), cols) };
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  let plan;
  try { plan = prepare(readFileSync(args.file, "utf8"), args); } catch (e) { console.error(`import-icd10: ${e.message}`); process.exit(1); }
  console.log(`Rows read: ${plan.rows}. Valid codes: ${plan.valid.length}. Rejected: ${plan.invalid.length}. Duplicates skipped: ${plan.duplicates.length}.`);
  for (const r of plan.invalid.slice(0, 20)) console.log(`  line ${r.line}: ${r.code || "(empty)"}: ${r.reason}`);
  if (plan.invalid.length > 20) console.log(`  ... and ${plan.invalid.length - 20} more rejected rows`);
  for (const d of plan.duplicates.slice(0, 10)) console.log(`  line ${d.line}: ${d.code} appears again (first row kept)`);
  if (plan.valid.length === 0) { console.error("import-icd10: nothing to import"); process.exit(1); }
  const batches = chunks(plan.valid);
  if (args.dryRun) { console.log(`Dry run: ${batches.length} batch(es) of up to ${BATCH} would be sent. Nothing was written.`); return; }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("import-icd10: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use --dry-run)"); process.exit(1); }
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const total = { inserted: 0, updated: 0, unchanged: 0 };
  for (const [i, batch] of batches.entries()) {
    const { data, error } = await sb.rpc("import_icd10_codes", { p_codes: batch });
    if (error) {
      console.error(`import-icd10: batch ${i + 1} of ${batches.length} was refused (${error.message}); batches before it are saved, nothing from this one. Totals so far: ${JSON.stringify(total)}`);
      process.exit(1);
    }
    const r = Array.isArray(data) ? data[0] : data;
    for (const k of Object.keys(total)) total[k] += Number(r?.[k] ?? 0);
    console.log(`Batch ${i + 1}/${batches.length}: ${batch.length} codes (inserted ${r?.inserted ?? 0}, updated ${r?.updated ?? 0}, unchanged ${r?.unchanged ?? 0})`);
  }
  console.log(`Done. Inserted ${total.inserted}, updated ${total.updated}, unchanged ${total.unchanged}. Codes are never deleted.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
