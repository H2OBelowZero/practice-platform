import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PASSWORD, ROLES, type RoleName } from "./roles";

// Direct-API clients: PostgREST called with the project's ANON key and a real user's access token, exactly what anyone holding a patient's
// browser session (or just the public anon key and a password) could do without using the website at all. Row-level security and the
// function guards are the only thing standing between that caller and other people's records. Tokens come from a password sign-in with
// supabase-js, are kept in memory only and are never put into a browser. Staff tokens are plain (aal1) sessions: RLS must hold regardless of aal.
const cache = new Map<string, Promise<SupabaseClient>>();

function make(): SupabaseClient {
  const url = process.env.E2E_SUPABASE_URL, key = process.env.E2E_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A client signed in as the seeded role, using the anon key. */
export function apiAs(role: RoleName): Promise<SupabaseClient> {
  let p = cache.get(role);
  if (!p) {
    p = (async () => {
      const sb = make();
      const { error } = await sb.auth.signInWithPassword({ email: ROLES[role].email, password: PASSWORD });
      if (error) throw new Error(`direct-API sign-in as ${ROLES[role].email} failed: ${error.message}`);
      return sb;
    })();
    cache.set(role, p);
  }
  return p;
}
/** The public anon key with no user. */
export const apiAnon = () => make();

export type Res = { data: unknown; error: { message: string; code?: string } | null; status?: number };

/** Rows a caller may see through the API (an error counts as none). Only for filtering lists; use classify / expectBlocked to ASSERT isolation. */
export function visibleRows(res: Res): unknown[] {
  if (res.error) return [];
  return Array.isArray(res.data) ? res.data : res.data == null ? [] : [res.data];
}

export type Outcome = { kind: "rows"; n: number } | { kind: "denied" } | { kind: "error"; message: string };
/**
 * What a read really came to. "denied" is ONLY a permission error (SQLSTATE 42501, or the words "permission denied"); every other error
 * (undefined table 42P01 / PGRST205, undefined column 42703, PostgREST or syntax errors) is kind "error": a typo must never pass as "no rows".
 */
export function classify(res: Res): Outcome {
  if (res.error) {
    const { code, message } = res.error;
    return code === "42501" || /permission denied/i.test(message) ? { kind: "denied" } : { kind: "error", message: `${code ?? ""} ${message}`.trim() };
  }
  const n = Array.isArray(res.data) ? res.data.length : res.data == null ? 0 : 1;
  return { kind: "rows", n };
}
/** Pass only for an RLS-empty result or a permission-denied error; anything else throws (including an unexpected error and any visible row). */
export function expectBlocked(res: Res, what: string): void {
  const o = classify(res);
  if (o.kind === "denied" || (o.kind === "rows" && o.n === 0)) return;
  throw new Error(`${what}: expected no rows or permission denied, got ${o.kind === "rows" ? o.n + " row(s)" : "error: " + o.message}`);
}
