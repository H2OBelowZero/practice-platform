import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { isPrefetch } from "@/lib/audit-viewer/filters";
import { toCsv } from "@/lib/reports/csv";
import { EXPORT_COLUMNS, exportRows } from "@/lib/reports/exports";
import { canExport, exportQuery, REPORT_ROLES } from "@/lib/reports/keys";
import { debtorsAsOf, debtorsProblem } from "@/lib/reports/periods";
import { ReportQueryError } from "@/lib/reports/queries";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...HEADERS } });

/**
 * CSV of one report: /app/reports/export?report=<key>&from=YYYY-MM-DD&to=YYYY-MM-DD. Same discipline as the audit export:
 *  - requireRole itself (the layout is not authorisation, R26), then the role must be allowed THAT report (psychologist, admin and bookkeeper for the money reports,
 *    psychologist and admin for appointments and activity, the psychologist alone for compliance); the database function applies the same rule again;
 *  - a prefetch / RSC request gets an empty 204 before anything is read or audited (the page links here with a plain <a download>, so this is a second line of defence);
 *  - the report key is a whitelist and the dates are Zod-checked (real dates, from <= to, at most 800 days), else 400;
 *  - rows are read with the signed-in user's client only (RLS), then export.report is audited (the key, the dates, the row count: never a name or an id) BEFORE a byte is
 *    returned, and if that write fails the export is refused with a 500 and no data;
 *  - every cell goes through toCsv (spreadsheet formulas neutralised), the header is fixed per report, the response is never cached.
 */
export async function GET(req: Request): Promise<Response> {
  const { role } = await requireRole(REPORT_ROLES);
  if (isPrefetch(req.headers)) return new Response(null, { status: 204, headers: HEADERS });

  const u = new URL(req.url).searchParams;
  const q = exportQuery.safeParse({ report: u.get("report"), from: u.get("from"), to: u.get("to") });
  if (!q.success) return text("This export link is not valid. Please go back to Reports and choose it again.", 400);
  const { report, from, to } = q.data;
  if (!canExport(role, report)) return text("You do not have access to this report.", 403);

  // debtors are "as at" one date (the end of the period, at most today), so the file is named for that date and an end date too far back is explained, not a generic failure
  const today = sastDate(new Date());
  const asOf = debtorsAsOf(to, today);
  if (report === "debtors") {
    const problem = debtorsProblem(asOf, today);
    if (problem) return text(problem, 422);
  }

  const sb = await supabaseServer();
  let rows;
  try {
    let vatRegistered = false;
    if (report === "income_by_month") {
      const { data } = await sb.from("practices").select("vat_registered").limit(1).maybeSingle();
      vatRegistered = (data as { vat_registered?: boolean } | null)?.vat_registered === true;
    }
    rows = await exportRows(sb, report, { from, to }, { vatRegistered, asOf });
  } catch (e) {
    if (e instanceof ReportQueryError && e.reason === "too_many_rows") return text("This period has too many lines for one file. Please choose a shorter period.", 422);
    if (e instanceof ReportQueryError && e.reason === "invalid_range") return text("The dates for this report are outside what can be reported. Please choose a period that ends more recently and is no longer than two years.", 422);
    console.error("report export failed:", e instanceof Error ? e.message.slice(0, 60) : "unknown");
    return text("The export could not be prepared. Please try again.", 500);
  }

  try {
    await audit("export.report", undefined, undefined, { report, from, to, rows: rows.length });
  } catch {
    console.error("export.report audit write failed: export refused");
    return text("The export was refused because it could not be recorded in the audit log. Nothing was downloaded. Please try again.", 500);
  }

  return new Response(`${toCsv(rows, EXPORT_COLUMNS[report])}\n`, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${report === "debtors" ? `debtors-as-at-${asOf}` : `${report}-${from}-${to}`}.csv"`, ...HEADERS },
  });
}
