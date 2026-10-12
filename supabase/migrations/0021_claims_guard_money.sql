-- supabase/migrations/0021_claims_guard_money.sql
-- Task 14 fix round 2. Allowing part_paid -> accepted (0020) opened two holes in the money state of a claim; both are closed in claims_guard.
--  1. A claim that holds scheme payments (claim_payments rows) only moves forward. With payments, the only status changes are the ones a remittance makes
--     (submitted|accepted|part_paid -> part_paid|paid) and part_paid -> accepted (the scheme paid before its advice). Anything else (accepted or part_paid ->
--     submitted, rejected or draft) raises 'claim_has_payments', for every writer: otherwise a claim holding money could be rejected (freeing its share of the
--     scheme portion for a sibling claim), reopened and edited, or resubmitted. claimed_cents can never go below the sum of the payments ('claimed_below_remitted').
--     A claim without payments keeps every move it had.
--  2. approved_cents is the money basis (what the scheme must pay), so it only changes in the transition INTO 'accepted'; any other update that changes it raises
--     'approved_frozen' (draft, submitted, accepted, part paid, paid; API roles and the owner alike; writing the same value is not a change). When a claim that already
--     holds payments is accepted, the approved (else claimed) amount must be at least what was paid ('approved_below_remitted'): an over-paid claim is refused instead of
--     silently becoming 'paid'. Staff correct such a case with a higher approved amount or by correcting the recorded payment (credit note / adjustment).
-- Same function as 0020 otherwise (SECURITY INVOKER, trusted-writer pattern, same privileges: create or replace keeps them).

create or replace function claims_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare api boolean := not _trusted_writer(tg_relid);
        inv invoices; v_patient uuid; v_others int; v_remitted int := 0;
begin
  if tg_op = 'UPDATE' then
    select coalesce(sum(amount_cents), 0) into v_remitted from claim_payments where claim_id = old.id;
    -- a claim that holds scheme money only moves forward
    if v_remitted > 0 and new.status is distinct from old.status and (old.status, new.status) not in (
         ('submitted','part_paid'),('submitted','paid'),('accepted','part_paid'),('accepted','paid'),('part_paid','paid'),('part_paid','accepted')) then
      raise exception 'claim_has_payments'; end if;
  end if;
  if api then
    -- the policies also say this, but a BEFORE trigger runs ahead of WITH CHECK and must not leak or mislead for other roles
    if auth.uid() is not null and coalesce(auth_role()::text, '') not in ('psychologist','admin') then raise exception 'forbidden'; end if;
    if auth.uid() is not null and auth_role()::text = 'admin' and (
         case when tg_op = 'INSERT' then coalesce(array_length(new.icd10_codes, 1), 0) > 0 else new.icd10_codes is distinct from old.icd10_codes end) then
      raise exception 'forbidden'; end if;
    if tg_op = 'INSERT' then
      if new.status <> 'draft' then raise exception 'claim_must_start_as_draft'; end if;
      new.submitted_at := null; new.reconciled_at := null;
    else
      if new.id is distinct from old.id or new.invoice_id is distinct from old.invoice_id or new.created_at is distinct from old.created_at then
        raise exception 'claim_link_frozen'; end if;
      if old.status <> 'draft' then
        if new.member_id is distinct from old.member_id then raise exception 'claim_link_frozen'; end if;
        if new.claimed_cents is distinct from old.claimed_cents then raise exception 'claim_amount_frozen'; end if;
        if new.icd10_codes is distinct from old.icd10_codes or new.tariff_code is distinct from old.tariff_code then raise exception 'claim_frozen'; end if;
      end if;
      new.submitted_at := old.submitted_at; new.reconciled_at := old.reconciled_at;
      if new.status is distinct from old.status and (old.status, new.status) not in (
           ('draft','submitted'),('submitted','accepted'),('submitted','rejected'),('accepted','submitted'),('rejected','submitted'),('rejected','draft'),
           ('part_paid','accepted')) then
        raise exception 'invalid_claim_transition'; end if;
    end if;
    select * into inv from invoices where id = new.invoice_id for update;
    if not found then raise exception 'unknown_invoice'; end if;
    if inv.status not in ('issued','part_paid') or inv.payer_type not in ('medical_aid','split') then raise exception 'invoice_not_claimable'; end if;
    if tg_op = 'INSERT' or new.member_id is distinct from old.member_id or new.claimed_cents is distinct from old.claimed_cents
       or (old.status = 'rejected' and new.status <> 'rejected') then
      select patient_id into v_patient from medical_aid_members where id = new.member_id;
      if not found then raise exception 'unknown_member'; end if;
      if v_patient <> inv.patient_id then raise exception 'member_patient_mismatch'; end if;
      if new.claimed_cents > inv.scheme_portion_cents then raise exception 'claim_exceeds_scheme_portion'; end if;
      if new.status <> 'rejected' then
        select coalesce(sum(claimed_cents), 0) into v_others from claims where invoice_id = new.invoice_id and status <> 'rejected' and id is distinct from new.id;
        if v_others + new.claimed_cents > inv.scheme_portion_cents then raise exception 'claims_exceed_scheme_portion'; end if;
      end if;
    end if;
    if (tg_op = 'INSERT' or new.icd10_codes is distinct from old.icd10_codes)
       and exists (select 1 from unnest(new.icd10_codes) as x(code) where not exists (select 1 from icd10_codes k where k.code = x.code)) then
      raise exception 'unknown_icd10'; end if;
  end if;
  if tg_op = 'UPDATE' then
    -- the amount the scheme must pay is only ever set by accepting the claim
    if new.approved_cents is distinct from old.approved_cents and not (new.status = 'accepted' and old.status is distinct from 'accepted') then
      raise exception 'approved_frozen'; end if;
    if v_remitted > 0 and new.claimed_cents < v_remitted then raise exception 'claimed_below_remitted'; end if;
    if new.status = 'accepted' and old.status is distinct from 'accepted' and v_remitted > 0 and v_remitted > coalesce(new.approved_cents, new.claimed_cents) then
      raise exception 'approved_below_remitted'; end if;
  end if;
  if new.status = 'rejected' and nullif(btrim(coalesce(new.rejection_reason, '')), '') is null then raise exception 'rejection_reason_required'; end if;
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status is distinct from 'submitted') then
    if coalesce(array_length(new.icd10_codes, 1), 0) < 1 then raise exception 'icd10_required'; end if;
    if new.claimed_cents <= 0 then raise exception 'claimed_amount_required'; end if;
    new.submitted_at := now();
  end if;
  -- accepted after the scheme has already paid: if what was paid covers the approved (else claimed) amount, the claim is simply paid
  if tg_op = 'UPDATE' and new.status = 'accepted' and old.status is distinct from 'accepted' then
    if v_remitted > 0 and v_remitted >= coalesce(new.approved_cents, new.claimed_cents) then new.status := 'paid'; end if;
  end if;
  return new; end $$;
