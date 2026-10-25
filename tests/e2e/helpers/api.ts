import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";
import { PASSWORD, ROLES, type RoleName } from "./roles";
import { secondsLeft, totp } from "./totp";

// Direct-API clients: PostgREST called with the project's ANON key and a real user's access token, exactly what anyone holding a patient's
// browser session (or just the public anon key and a password) could do without using the website at all. Row-level security and the
// function guards are the only thing standing between that caller and other people's records. Tokens come from a password sign-in with
// supabase-js, are kept in memory only and are never put into a browser.
// Staff: the database gives a staff role only to a two-step (aal2) session (migration 0030). apiAs() therefore completes the TOTP step for staff
// with the secret global setup saved (tests/e2e/.auth/totp-<role>.json); `{ aal: "aal1" }` stops after the password, which is what a stolen password
// alone gives, and must read nothing of the practice's data.
const cache = new Map<string, Promise<SupabaseClient>>();

function make(): SupabaseClient {
  const url = process.env.E2E_SUPABASE_URL, key = process.env.E2E_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("E2E_SUPABASE_URL and E2E_SUPABASE_ANON_KEY must be set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Upgrade a signed-in staff client to aal2 with the saved TOTP secret (global setup enrolled it through /mfa). */
async function stepUp(sb: SupabaseClient, role: RoleName): Promise<void> {
  const file = ROLES[role].totpFile;
  const secret = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { secret?: string }).secret : undefined;
  if (!secret) throw new Error(`no saved authenticator secret for ${ROLES[role].email} (${file}): run the e2e global setup first`);
  const { data: factors, error: fe } = await sb.auth.mfa.listFactors();
  const factor = factors?.totp?.[0];
  if (fe || !factor) throw new Error(`${ROLES[role].email} has no verified TOTP factor`);
  if (secondsLeft() <= 2) await new Promise((r) => setTimeout(r, 3000));
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(secret) });
  if (error) throw new Error(`TOTP step for ${ROLES[role].email} failed: ${error.message}`);
}

/** A client signed in as the seeded role, using the anon key. Staff get an aal2 session unless `aal: "aal1"` is asked for. */
export function apiAs(role: RoleName, opts: { aal?: "aal1" | "aal2" } = {}): Promise<SupabaseClient> {
  const aal = ROLES[role].staff ? (opts.aal ?? "aal2") : "aal1";
  let p = cache.get(`${role}:${aal}`);
  if (!p) {
    p = (async () => {
      const sb = make();
      const { error } = await sb.auth.signInWithPassword({ email: ROLES[role].email, password: PASSWORD });
      if (error) throw new Error(`direct-API sign-in as ${ROLES[role].email} failed: ${error.message}`);
      if (aal === "aal2") await stepUp(sb, role);
      return sb;
    })();
    cache.set(`${role}:${aal}`, p);
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
