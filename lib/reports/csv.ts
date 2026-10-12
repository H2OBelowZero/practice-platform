export type CsvCell = string | number | null;

/**
 * One CSV cell (RFC 4180): a field with a comma, quote, CR or LF is wrapped in quotes with inner quotes doubled.
 * Spreadsheet formula injection: a TEXT cell that starts with = + - @ (or a tab / carriage return, which Excel also strips before reading a formula)
 * gets a leading single quote, so Excel and Sheets show it as text instead of running it. Numbers are written as they are (a negative amount stays a number).
 */
export function csvCell(v: CsvCell): string {
  let s = v === null ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows as CSV with a header line (the keys of the first row, or `columns` when given, which also gives an empty export its header).
 * Lines are joined with \n and there is no trailing newline.
 */
export function toCsv(rows: Record<string, CsvCell>[], columns?: string[]): string {
  const keys = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  if (!keys.length) return "";
  return [keys.map(csvCell).join(","), ...rows.map((r) => keys.map((k) => csvCell(r[k] ?? null)).join(","))].join("\n");
}
