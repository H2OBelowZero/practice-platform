import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { auditDetailSummary, auditTime, shortEntityId } from "@/lib/audit-viewer/detail";
import { activeFilterNames, applyAuditFilters, EXPORT_CHUNK, EXPORT_MAX_ROWS, isPrefetch, parseAuditFilters } from "@/lib/audit-viewer/filters";
import { toCsv } from "@/lib/reports/csv";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const COLUMNS = ["time_sast", "role", "action", "entity", "entity_id", "detail"];
type Row = { id: number; role: string | null; action: string; entity: string | null; entity_id: string | null; detail: unknown; at: string };
const COLS = "id, role, action, entity, entity_id, detail, at";
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)$/;

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...HEADERS } });

/**
 * CSV of the audit log with the same filters as the viewer: newest first, at most 5000 rows. Rows are read in chunks of 1000 (the API returns no more per request)
 * with KEYSET paging on (at desc, id desc): each chunk starts strictly after the last row of the previous one, so audit rows written while the export runs
 * can neither duplicate nor skip a row. Psychologist only (requireRole itself: the layout is not authorisation, R26). Every cell goes through toCsv, which
 * neutralises spreadsheet formulas, and the detail column is the whitelisted summary, never raw JSON. The export is audited (export.audit: filter NAMES and
 * the row count) and FAILS CLOSED: the audit row is written before a single byte is returned, and if that write fails the export is refused.
 * A prefetch / RSC request (a browser or router warming a link) gets an empty 204 before anything is read or audited; the page links here with a plain
 * <a download>, so this is only a second line of defence.
 */
export async function GET(req: Request): Promise<Response> {
  await requireRole(["psychologist"]);
  if (isPrefetch(req.headers)) return new Response(null, { status: 204, headers: HEADERS });
  const u = new URL(req.url).searchParams;
  const f = parseAuditFilters({ prefix: u.get("prefix") ?? undefined, entity: u.get("entity") ?? undefined, role: u.get("role") ?? undefined, from: u.get("from") ?? undefined, to: u.get("to") ?? undefined });

  const sb = await supabaseServer();
  const chunk = async (after: Row | null, limit: number): Promise<Row[] | null> => {
    let q = applyAuditFilters(sb.from("audit_log").select(COLS), f);
    if (after) {
      if (!TIMESTAMP.test(after.at) || !Number.isSafeInteger(after.id)) return null;
      q = q.or(`at.lt."${after.at}",and(at.eq."${after.at}",id.lt.${after.id})`);
    }
    const res = await q.order("at", { ascending: false }).order("id", { ascending: false }).limit(limit);
    return res.error ? null : ((res.data ?? []) as Row[]);
  };

  const rows: Row[] = [];
  while (rows.length < EXPORT_MAX_ROWS) {
    const want = Math.min(EXPORT_CHUNK, EXPORT_MAX_ROWS - rows.length);
    const part = await chunk(rows.at(-1) ?? null, want);
    if (!part) return text("The export could not be prepared. Please try again.", 500);
    rows.push(...part);
    if (part.length < want) break;
  }
  let truncated = false;
  if (rows.length >= EXPORT_MAX_ROWS) {
    const more = await chunk(rows.at(-1) ?? null, 1); // is there anything beyond the cap?
    if (!more) return text("The export could not be prepared. Please try again.", 500);
    truncated = more.length > 0;
  }

  try {
    await audit("export.audit", "audit_log", undefined, { filters: activeFilterNames(f), rows: rows.length, truncated });
  } catch {
    console.error("export.audit audit write failed: export refused");
    return text("The export was refused because it could not be recorded in the audit log. Nothing was downloaded. Please try again.", 500);
  }

  const csv = toCsv(rows.map((r) => ({
    time_sast: auditTime(r.at), role: r.role ?? "system", action: r.action, entity: r.entity, entity_id: shortEntityId(r.entity_id) || null, detail: auditDetailSummary(r.detail),
  })), COLUMNS);
  return new Response(`${csv}\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${sastDate(new Date())}.csv"`,
      "X-Export-Truncated": truncated ? "true" : "false",
      ...HEADERS,
    },
  });
}
