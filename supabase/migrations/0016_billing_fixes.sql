-- supabase/migrations/0016_billing_fixes.sql
-- Task 13b fix round 1.
--  1. Issuing checks the lines: when a draft has lines, they must add up to the subtotal and subtotal - discount + VAT must equal the total
--     ('lines_mismatch'). Lines are written through create/save_invoice_draft (which already check), but the table is also writable directly by
--     staff through PostgREST, so the issue step is the last place where "what the patient is billed" and "what the lines say" must agree.
--     (A draft with no lines at all is left alone: older tests and imports create such invoices directly.)
--  2. billing_totals gets p_patient so one patient's Billing tab can show exact totals instead of summing a limited page.

-- same as 0005's invoices_guard except for the lines_mismatch block
create or replace function invoices_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare api boolean := not _trusted_writer(tg_relid); s bigint;
begin
  if tg_op = 'INSERT' then
    if api and new.status <> 'draft' then raise exception 'invoice_must_start_as_draft'; end if;
  else
    if old.status = 'void' and new.status <> 'void' then raise exception 'invoice_void_is_final'; end if;
    if new.status = 'draft' and old.status <> 'draft' then raise exception 'invalid_invoice_transition'; end if;
    if new.status is distinct from old.status then
      if api and (old.status, new.status) not in (('draft','issued'),('issued','void'),('draft','void')) then
        raise exception 'invalid_invoice_transition'; end if;
      if api and new.status = 'void' and exists (select 1 from payments where invoice_id = old.id and status = 'succeeded') then
        raise exception 'invoice_has_payments'; end if;
      if new.status = 'void' and exists (select 1 from claims where invoice_id = old.id and status in ('submitted','accepted','part_paid','paid')) then
        raise exception 'invoice_has_open_claims'; end if;
    end if;
    if api then
      if new.id is distinct from old.id or new.created_at is distinct from old.created_at or new.number is distinct from old.number then
        raise exception 'invoice_frozen'; end if;
      if old.status <> 'draft' and (
           new.patient_id is distinct from old.patient_id or new.appointment_id is distinct from old.appointment_id
        or new.issue_date is distinct from old.issue_date
        or new.subtotal_cents is distinct from old.subtotal_cents or new.discount_cents is distinct from old.discount_cents
        or new.vat_cents is distinct from old.vat_cents or new.total_cents is distinct from old.total_cents
        or new.scheme_portion_cents is distinct from old.scheme_portion_cents or new.patient_portion_cents is distinct from old.patient_portion_cents
        or new.payer_type is distinct from old.payer_type) then
        raise exception 'invoice_frozen'; end if;
    end if;
  end if;
  if new.status in ('issued','part_paid','paid') and (tg_op = 'INSERT' or old.status = 'draft') then
    if new.total_cents = 0 then raise exception 'zero_total'; end if;
    if new.scheme_portion_cents + new.patient_portion_cents <> new.total_cents then raise exception 'portions_mismatch'; end if;
    if new.payer_type = 'self' and new.scheme_portion_cents <> 0 then raise exception 'self_pay_has_scheme_portion'; end if;
    if tg_op = 'UPDATE' then
      if exists (select 1 from invoice_lines where invoice_id = new.id) then
        select coalesce(sum(quantity::bigint * unit_cents), 0) into s from invoice_lines where invoice_id = new.id;
        if s <> new.subtotal_cents or new.discount_cents > new.subtotal_cents
           or new.subtotal_cents - new.discount_cents + new.vat_cents <> new.total_cents then
          raise exception 'lines_mismatch'; end if;
      end if;
      new.issue_date := sa_today();
    end if;
  end if;
  return new; end $$;

-- billing_totals with an optional patient filter (new trailing parameter; every existing call keeps working)
drop function billing_totals(text, text, boolean, text, date);
create function billing_totals(p_status text default null, p_payer text default null, p_overdue boolean default false,
                               p_q text default null, p_today date default sa_today(), p_patient uuid default null)
returns table (n bigint, invoiced_cents bigint, credited_cents bigint, received_cents bigint, outstanding_cents bigint)
language sql stable set search_path = public, pg_temp as $$
  select count(*),
         coalesce(sum(b.total_cents) filter (where b.status in ('issued','part_paid','paid')), 0)::bigint,
         coalesce(sum(b.credit_cents) filter (where b.status in ('issued','part_paid','paid')), 0)::bigint,
         coalesce(sum(b.paid_cents) filter (where b.status in ('issued','part_paid','paid')), 0)::bigint,
         coalesce(sum(b.outstanding_cents), 0)::bigint
  from invoice_balances b
  where (p_status is null or b.status = p_status)
    and (p_payer is null or b.payer_type = p_payer)
    and (p_patient is null or b.patient_id = p_patient)
    and (not coalesce(p_overdue, false) or (b.due_date < p_today and b.status in ('issued','part_paid')))
    and (nullif(p_q, '') is null or b.number ilike '%' || replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_') || '%') $$;
revoke execute on function billing_totals(text, text, boolean, text, date, uuid) from public, anon;
grant execute on function billing_totals(text, text, boolean, text, date, uuid) to authenticated, service_role;
