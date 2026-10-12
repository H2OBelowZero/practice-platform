-- supabase/migrations/0018_credit_note_reasons.sql
-- Task 13c fix round 1 (I2). credit_notes.reason is staff free text ("goodwill - difficult family situation") and created_by names the staff member;
-- the cr_own policy lets patients and guardians (with pay permission) read their invoice's credit note ROWS, and until now that included both columns.
-- Patients, guardians and all staff share the Postgres role `authenticated`, so a column grant cannot separate them: the table is limited to the
-- columns everybody may read, and the two private columns are served by credit_note_details(), which checks the caller's application role.
--  * authenticated: select on id, invoice_id, amount_cents, portion, created_at only (so `select *`, `reason` and `created_by` are "permission denied").
--    The insert privilege is untouched; an INSERT without RETURNING (what the app does) needs no select privilege.
--  * invoice_balances is SECURITY INVOKER but reads only invoice_id, amount_cents and portion, all still granted.
--  * service_role keeps its table-level select (its insert/update/delete were revoked in 0005 and stay revoked). It is a server-only key.
--  * the owner / triggers (security definer) are unaffected.

revoke select on credit_notes from authenticated;
grant select (id, invoice_id, amount_cents, portion, created_at) on credit_notes to authenticated;

-- Staff only: psychologist and admin. The bookkeeper is excluded on purpose (R39), as are associates, patients and guardians.
-- Qualified column names throughout: the OUT parameters of RETURNS TABLE are variables inside a plpgsql body.
create function credit_note_details(p_invoice uuid) returns table (id uuid, reason text, created_by uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if coalesce(auth_role()::text, '') not in ('psychologist','admin') then raise exception 'forbidden'; end if;
  return query select c.id, c.reason, c.created_by from credit_notes c where c.invoice_id = p_invoice order by c.created_at, c.id;
end $$;
revoke execute on function credit_note_details(uuid) from public, anon;
grant execute on function credit_note_details(uuid) to authenticated, service_role;
