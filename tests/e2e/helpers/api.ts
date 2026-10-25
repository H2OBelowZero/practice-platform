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

type Res = { data: unknown; error: { message: string; code?: string } | null };
/** Rows a caller may see through the API: none when RLS filters everything, and an error (permission denied) counts as none. */
export function visibleRows(res: Res): unknown[] {
  if (res.error) return [];
  return Array.isArray(res.data) ? res.data : res.data == null ? [] : [res.data];
}
