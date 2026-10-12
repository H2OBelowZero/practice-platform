-- supabase/migrations/0026_void_with_credits.sql
-- Task 16b fix round 2. An invoice that has credit notes cannot be voided BY HAND ('invoice_has_credits'): the reports treat an invoice voided by credits as still invoiced and
-- count every credit note, so a hand void after a partial credit would take the invoice out of "invoiced" while its credit stayed in, understating net income and VAT.
-- The way to close such an invoice is to credit the remainder, which the database then voids itself (invoice_recompute, a trusted definer function: it is the owner, so
-- `api` is false for it and this new rule does not apply). Everything else in invoices_guard is exactly as in 0016: no void while a succeeded payment exists (API roles),
-- none while a claim is submitted / accepted / part_paid / paid (everyone), only draft -> issued, issued -> void and draft -> void for API roles, then the issue-time checks.
-- Same SECURITY INVOKER trusted-writer pattern and search_path as 0005 / 0016, so the grants are unchanged.

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
      if api and new.status = 'void' and exists (select 1 from credit_notes where invoice_id = old.id) then
        raise exception 'invoice_has_credits'; end if;
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
