import { addDays, isRealDate, sastMidnight } from "@/lib/time";

/** The action prefixes (the part before the dot) the application writes. The filter is a select over these, so no user text ever reaches the query. */
export const AUDIT_PREFIXES = [
  "appointment", "audit", "auth", "booking", "claim", "consent", "credit_note", "cron", "export", "form", "invoice", "member", "note", "patient",
  "payfast", "payment", "prefs", "task",
] as const;
export const AUDIT_ENTITIES = [
  "appointments", "audit_log", "claims", "clinical_notes", "credit_notes", "form_submissions", "invoices", "medical_aid_members", "patients", "payments", "session", "tasks",
] as const;
export const AUDIT_ROLES = ["psychologist", "admin", "bookkeeper", "associate", "patient", "guardian", "system"] as const;

export type AuditFilters = { prefix: string; entity: string; role: string; from: string; to: string };

const oneOf = (list: readonly string[], v: string | undefined) => (v !== undefined && list.includes(v) ? v : "");
const date = (v: string | undefined) => (v !== undefined && isRealDate(v) && v >= "2000-01-01" && v <= "2100-12-31" ? v : "");

/** Filters from the URL: anything not on the lists above (or not a real date) is "no filter". */
export function parseAuditFilters(sp: { prefix?: string; entity?: string; role?: string; from?: string; to?: string }): AuditFilters {
  return { prefix: oneOf(AUDIT_PREFIXES, sp.prefix), entity: oneOf(AUDIT_ENTITIES, sp.entity), role: oneOf(AUDIT_ROLES, sp.role), from: date(sp.from), to: date(sp.to) };
}

/** Names of the filters that are set (what the audit row for viewing or exporting records, never their values). */
export const activeFilterNames = (f: AuditFilters): string[] => (Object.keys(f) as (keyof AuditFilters)[]).filter((k) => f[k] !== "");

/** The query-string parameters for links, the pager and the export (empty ones left out by hrefWith). */
export const filterParams = (f: AuditFilters): Record<string, string> => ({ prefix: f.prefix, entity: f.entity, role: f.role, from: f.from, to: f.to });

type Chain = { like(c: string, p: string): Chain; neq(c: string, v: string): Chain; eq(c: string, v: string): Chain; gte(c: string, v: string): Chain; lt(c: string, v: string): Chain };

/** Apply the filters to a PostgREST query builder (the page query and the export query share this). The date range is in SAST: from the start of `from` up to the end of `to`. */
export function applyAuditFilters<Q>(q: Q, f: AuditFilters, opts: { hideViews?: boolean } = {}): Q {
  let out = q as unknown as Chain;
  // the viewer writes an audit.view row on every page view; counting it would shift every offset page by one per click, so it is left out unless the audit.* filter asks for it
  if (opts.hideViews && f.prefix !== "audit") out = out.neq("action", "audit.view");
  if (f.prefix) out = out.like("action", `${f.prefix}.%`);
  if (f.entity) out = out.eq("entity", f.entity);
  if (f.role) out = out.eq("role", f.role);
  if (f.from) out = out.gte("at", sastMidnight(f.from));
  if (f.to) out = out.lt("at", sastMidnight(addDays(f.to, 1)));
  return out as unknown as Q;
}

export const EXPORT_MAX_ROWS = 5000;
/** PostgREST returns at most this many rows per request on Supabase, so an export reads in pages of it. */
export const EXPORT_CHUNK = 1000;

/** True for a request a browser or the Next router makes to warm a link (prefetch / RSC), as opposed to a person's click on a download. */
export function isPrefetch(h: { get(name: string): string | null }): boolean {
  const v = (n: string) => (h.get(n) ?? "").toLowerCase();
  return h.get("next-router-prefetch") !== null || h.get("rsc") !== null || v("purpose").includes("prefetch") || v("sec-purpose").includes("prefetch");
}
