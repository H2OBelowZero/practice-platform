-- supabase/migrations/0007_audit_app.sql (R25)
-- audit_write derives the actor from auth.uid(); callable by any authenticated user it let a patient append
-- fake audit rows. It stays for DB-internal callers only (security definer triggers/functions run as the owner).
revoke execute on function audit_write(text, text, uuid, jsonb) from public, anon, authenticated;

-- The application entry point: the Next.js server calls this through the service-role client, passing the
-- actor and role it resolved from the verified session (never client-supplied). Not callable by anyone else.
create function audit_append(p_actor uuid, p_role text, p_action text, p_entity text, p_entity_id uuid, p_detail jsonb) returns void
language sql security definer set search_path = public, pg_temp as
$$ insert into audit_log(actor_id, role, action, entity, entity_id, detail) values (p_actor, p_role, p_action, p_entity, p_entity_id, p_detail) $$;
revoke execute on function audit_append(uuid, text, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function audit_append(uuid, text, text, text, uuid, jsonb) to service_role;
