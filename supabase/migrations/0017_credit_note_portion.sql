-- supabase/migrations/0017_credit_note_portion.sql
-- Task 13c (portal payments) + ruling R40.
--  1. credit_notes.portion ('patient' | 'scheme'): which side of the invoice a credit note settles. A scheme credit writes off what the medical
--     aid will not pay (the shortfall); a patient credit is a discount or write-off for the patient. Existing rows (none in production) become
--     'patient'. New rows must say which: there is deliberately NO column default.
--     Rules (in credit_notes_guard, on top of the overall cap that stays): a self-pay invoice only takes 'patient' credits ('portion_not_allowed');
--     a 'scheme' credit may not exceed what the medical aid still owes: scheme portion - remittances (medical_aid payments) - earlier scheme
--     credits ('credit_exceeds_scheme_portion'); a 'patient' credit may not exceed what the patient still owes: patient portion - the patient's own
--     payments (every method but medical_aid) - earlier patient credits ('credit_exceeds_patient_portion'). Remaining amounts never go below zero.
--  2. invoice_balances gains scheme_credit_cents / patient_credit_cents (new trailing columns; security_invoker and the grants are unchanged).
--  3. practices.payment_instructions: plain text shown to patients next to the online payment option (bank details for EFT). Psychologist-edited.

alter table credit_notes add column portion text not null default 'patient' check (portion in ('patient','scheme'));
alter table credit_notes alter column portion drop default;

create or replace function credit_notes_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; credits int; paid int; remitted int; own_paid int; scheme_credits int; patient_credits int;
begin
  -- before any invoice is looked at (a BEFORE trigger runs ahead of the RLS check): psychologist only
  if auth.uid() is not null and coalesce(auth_role()::text, '') <> 'psychologist' then raise exception 'forbidden'; end if;
  new.created_by := auth.uid();
  if nullif(btrim(new.reason), '') is null then raise exception 'reason_required'; end if;
  if new.portion is null or new.portion not in ('patient','scheme') then raise exception 'portion_required'; end if;
  select * into inv from invoices where id = new.invoice_id for update;
  if not found then raise exception 'unknown_invoice'; end if;
  if inv.status not in ('issued','part_paid') then raise exception 'invoice_not_creditable'; end if;
  select coalesce(sum(amount_cents),0), coalesce(sum(amount_cents) filter (where portion = 'scheme'),0), coalesce(sum(amount_cents) filter (where portion = 'patient'),0)
    into credits, scheme_credits, patient_credits from credit_notes where invoice_id = inv.id;
  paid := invoice_paid_cents(inv.id);
  if credits + paid + new.amount_cents > inv.total_cents then raise exception 'credit_exceeds_outstanding'; end if;
  if new.portion = 'scheme' then
    if inv.payer_type = 'self' then raise exception 'portion_not_allowed'; end if;
    select coalesce(sum(amount_cents),0) into remitted from payments where invoice_id = inv.id and status = 'succeeded' and method = 'medical_aid';
    if new.amount_cents > greatest(0, inv.scheme_portion_cents - remitted - scheme_credits) then raise exception 'credit_exceeds_scheme_portion'; end if;
  else
    select coalesce(sum(amount_cents),0) into own_paid from payments where invoice_id = inv.id and status = 'succeeded' and method <> 'medical_aid';
    if new.amount_cents > greatest(0, inv.patient_portion_cents - own_paid - patient_credits) then raise exception 'credit_exceeds_patient_portion'; end if;
  end if;
  return new; end $$;

create or replace function credit_notes_after() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform invoice_recompute(new.invoice_id);
  perform audit_write('credit_note.create', 'credit_notes', new.id,
    jsonb_build_object('invoice_id', new.invoice_id, 'amount', new.amount_cents, 'portion', new.portion, 'reason', new.reason));
  return null; end $$;

-- same columns as 0015 in the same order, then the two new ones
create or replace view invoice_balances with (security_invoker = true) as
  select i.id, i.number, i.patient_id, i.appointment_id, i.status, i.payer_type, i.issue_date, i.due_date, i.created_at,
         i.total_cents, i.scheme_portion_cents, i.patient_portion_cents,
         coalesce(p.paid, 0)::int as paid_cents, coalesce(c.credit, 0)::int as credit_cents,
         case when i.status in ('issued','part_paid') then greatest(0, i.total_cents - coalesce(c.credit, 0) - coalesce(p.paid, 0))::int else 0 end as outstanding_cents,
         coalesce(c.scheme_credit, 0)::int as scheme_credit_cents, coalesce(c.patient_credit, 0)::int as patient_credit_cents
  from invoices i
  left join (select invoice_id, sum(amount_cents) as paid from payments where status = 'succeeded' group by invoice_id) p on p.invoice_id = i.id
  left join (select invoice_id, sum(amount_cents) as credit,
                    sum(amount_cents) filter (where portion = 'scheme') as scheme_credit,
                    sum(amount_cents) filter (where portion = 'patient') as patient_credit
             from credit_notes group by invoice_id) c on c.invoice_id = i.id;
revoke all on invoice_balances from anon, authenticated, service_role;
grant select on invoice_balances to authenticated, service_role;

alter table practices add column payment_instructions text not null default 'Please contact the practice for EFT details.';
