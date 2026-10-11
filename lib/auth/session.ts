import { redirect, notFound } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { type Role, needsMfa } from "./roles";

const ROLES: readonly Role[] = ["psychologist", "admin", "bookkeeper", "patient", "guardian", "associate"];

/**
 * The verified signed-in user and their role, or null. Uses getUser() (validated by the Auth server), never
 * getSession() alone, because the cookie session is client-controlled. No MFA or role enforcement here.
 */
export async function currentUser(sb?: SupabaseClient): Promise<{ userId: string; role: Role } | null> {
  const client = sb ?? (await supabaseServer());
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  const { data: profile } = await client.from("profiles").select("role").eq("user_id", user.id).maybeSingle();
  const role = profile?.role as Role | undefined;
  return role && ROLES.includes(role) ? { userId: user.id, role } : null;
}

/** Any signed-in role. Anonymous -> /login; staff without aal2 -> /mfa. */
export async function requireUser(): Promise<{ userId: string; role: Role }> {
  const sb = await supabaseServer();
  const me = await currentUser(sb);
  if (!me) redirect("/login");
  if (needsMfa(me.role)) {
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== "aal2") redirect("/mfa");
  }
  return me;
}

/** Signed-in user whose role is in `allowed`; any other role gets a 404 (do not reveal the area exists). */
export async function requireRole(allowed: Role[]): Promise<{ userId: string; role: Role }> {
  const me = await requireUser();
  if (!allowed.includes(me.role)) notFound();
  return me;
}
