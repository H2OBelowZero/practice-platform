import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { auditDetailSummary, auditTime, shortEntityId } from "@/lib/audit-viewer/detail";
import { activeFilterNames, applyAuditFilters, EXPORT_CHUNK, EXPORT_MAX_ROWS, parseAuditFilters } from "@/lib/audit-viewer/filters";
import { toCsv } from "@/lib/reports/csv";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const COLUMNS = ["time_sast", "role", "action", "entity", "entity_id", "detail"];
type Row = { role: string | null; action: string; entity: string | null; entity_id: string | null; detail: unknown; at: string };

const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * CSV of the audit log with the same filters as the viewer: newest first, at most 5000 rows, read in pages of 1000 (the API returns no more per request).
 * Psychologist only (requireRole itself: the layout is not authorisation, R26). Every cell goes through toCsv, which neutralises spreadsheet formulas, and the
 * detail column is the whitelisted summary, never raw JSON. The export is audited (export.audit: filter NAMES and the row count) and FAILS CLOSED: the audit row is
 * written before a single byte is returned, and if that write fails the export is refused.
 */
export async function GET(req: Request): Promise<Response> {
  await requireRole(["psychologist"]);
  const u = new URL(req.url).searchParams;
  const f = parseAuditFilters({ prefix: u.get("prefix") ?? undefined, entity: u.get("entity") ?? undefined, role: u.get("role") ?? undefined, from: u.get("from") ?? undefined, to: u.get("to") ?? undefined });

  const sb = await supabaseServer();
  const rows: Row[] = [];
  let truncated = false;
  for (let from = 0; from < EXPORT_MAX_ROWS; from += EXPORT_CHUNK) {
    const res = await applyAuditFilters(sb.from("audit_log").select("role, action, entity, entity_id, detail, at"), f)
      .order("at", { ascending: false }).order("id", { ascending: false }).range(from, from + EXPORT_CHUNK - 1);
    if (res.error) return text("The export could not be prepared. Please try again.", 500);
    const part = (res.data ?? []) as Row[];
    rows.push(...part);
    if (part.length < EXPORT_CHUNK) break;
    if (from + EXPORT_CHUNK >= EXPORT_MAX_ROWS) {
      // the cap is reached: is there anything beyond it?
      const more = await applyAuditFilters(sb.from("audit_log").select("id"), f).order("at", { ascending: false }).order("id", { ascending: false }).range(EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
      truncated = !more.error && (more.data?.length ?? 0) > 0;
    }
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
      "Cache-Control": "no-store",
      "X-Export-Truncated": truncated ? "true" : "false",
    },
  });
}
