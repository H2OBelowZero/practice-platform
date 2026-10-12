-- supabase/migrations/0024_dashboard_queries.sql
-- Task 16a. What the staff dashboard, the tasks page and the audit viewer need from the database.
--  1. dashboard_payments_by_method(p_from, p_to): money received per method over a date range, summed in the database. SECURITY INVOKER, so the
--     caller's RLS applies (payments are readable by psychologist, admin and bookkeeper only); the function also refuses every other role outright
--     (a patient or guardian can read their own payments through pay_own, and must not be able to ask for a practice-wide figure shape).
--     It returns method, count and total only: no reference, no invoice, no patient.
--  2. Indexes for the audit viewer (newest first, by entity, by actor over time) and for the tasks page (status + due date, source prefix).

-- ---- 1. payments received per method ----------------------------------------------------------------------------------------------
create function dashboard_payments_by_method(p_from date, p_to date)
returns table (method text, n bigint, total_cents bigint)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
begin
  if coalesce(auth_role()::text, '') not in ('psychologist', 'admin', 'bookkeeper') then raise exception 'forbidden'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'invalid_range'; end if;
  return query
    select p.method, count(*)::bigint, coalesce(sum(p.amount_cents), 0)::bigint
    from payments p
    where p.status = 'succeeded' and p.received_on >= p_from and p.received_on <= p_to
    group by p.method order by p.method;
end $$;
revoke execute on function dashboard_payments_by_method(date, date) from public, anon;
grant execute on function dashboard_payments_by_method(date, date) to authenticated, service_role;

-- ---- 2. indexes -------------------------------------------------------------------------------------------------------------------
-- audit viewer: newest first with a date range; "everything about this record"; "what did this person do, and when"
create index if not exists audit_log_at_idx on audit_log (at desc);
create index if not exists audit_log_entity_idx on audit_log (entity, entity_id);
create index if not exists audit_log_actor_at_idx on audit_log (actor_id, at);
-- tasks page and dashboard: open tasks by due date, and source prefixes ("payfast_unreconciled:%", "overdue_invoice:%") that a plain btree cannot serve under a non-C collation
create index if not exists tasks_status_due_idx on tasks (status, due_at);
create index if not exists tasks_source_prefix_idx on tasks (source text_pattern_ops);
