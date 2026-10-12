-- supabase/migrations/0014_payfast_unreconciled.sql
-- Task 13a fix round 1. A genuine PayFast payment (signature, IP, merchant and PayFast's own validate all pass) can arrive for an
-- invoice that no longer accepts it: paid meanwhile (double payment), voided, credited, or part-paid by a scheme remittance between
-- checkout and ITN. The money is real, so the ITN answers 200 and raises ONE staff task for the practice to reconcile (refund through
-- the PayFast dashboard or record an adjustment). The task carries financial ids and amounts only, no clinical data, and is visible to
-- psychologist and admin like any ordinary task (its source does not match 'risk_flag:%', see 0013).

create unique index tasks_payfast_unreconciled_once on tasks (source) where source like 'payfast_unreconciled:%';

-- Called by the ITN route through the service client only. One task per pf_payment_id: a PayFast retry is a no-op.
create function raise_payfast_unreconciled(p_invoice uuid, p_pf_payment_id text, p_amount_cents int, p_outstanding_cents int, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_patient uuid;
begin
  if p_pf_payment_id is null or p_pf_payment_id !~ '^[0-9]{1,20}$' then raise exception 'invalid_pf_payment_id'; end if;
  if p_reason is null or p_reason not in ('amount_mismatch', 'invoice_not_payable', 'overpay') then raise exception 'invalid_reason'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_outstanding_cents is null or p_outstanding_cents < 0 then raise exception 'invalid_amount'; end if;
  select patient_id into v_patient from invoices where id = p_invoice;
  if not found then raise exception 'unknown_invoice'; end if;
  insert into tasks(title, priority, patient_id, source, meta)
  values ('PayFast payment needs reconciliation', 'high', v_patient, 'payfast_unreconciled:' || p_pf_payment_id,
          jsonb_build_object('invoice_id', p_invoice, 'pf_payment_id', p_pf_payment_id, 'reason', p_reason,
                             'amount_cents', p_amount_cents, 'outstanding_cents', p_outstanding_cents))
  on conflict (source) where source like 'payfast_unreconciled:%' do nothing;
end $$;
revoke execute on function raise_payfast_unreconciled(uuid, text, int, int, text) from public, anon, authenticated;
grant execute on function raise_payfast_unreconciled(uuid, text, int, int, text) to service_role;
