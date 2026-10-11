import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { currentUser } from "@/lib/auth/session";

/**
 * Append an audit row. The actor and role come from the verified session resolved on the server (getUser + profiles),
 * never from the caller, and the write goes through the service-role-only audit_append() function (R25).
 * No signed-in user -> nothing is written. Throws if the audit write fails (fail closed).
 * `sb` lets a caller that has just signed in pass the client that holds the new session.
 */
export async function audit(action: string, entity?: string, entityId?: string, detail?: object, sb?: SupabaseClient): Promise<void> {
  const me = await currentUser(sb ?? (await supabaseServer()));
  if (!me) return;
  const { error } = await supabaseService().rpc("audit_append", {
    p_actor: me.userId, p_role: me.role, p_action: action,
    p_entity: entity ?? null, p_entity_id: entityId ?? null, p_detail: detail ?? null,
  });
  if (error) throw new Error(`audit_append failed: ${error.code ?? ""} ${error.message}`);
}
