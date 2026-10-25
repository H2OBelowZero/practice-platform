-- supabase/migrations/0032_claims_insurer_consent.sql
-- Final review I4 (POPIA). A medical aid claim sends the patient's identity, membership and ICD-10 diagnosis codes to the scheme. The patient's
-- 'share_insurer' consent (given by submitting the "Permission to share information with your medical aid" form, share_with_insurer) is required
-- before a claim may be marked submitted, and again for a resubmission (accepted|rejected -> submitted): a consent withdrawn in the meantime stops it.
-- 'share_insurer_consent_required' for every writer, like icd10_required (0020): the API roles, the service role and the owner alike.
-- What happens after submission (accepted, rejected, part paid, paid, remittances) does not need a fresh check: withdrawing does not recall a claim
-- that was already sent (the form's own wording says so).
--
-- Same function as 0021 otherwise (SECURITY INVOKER, trusted-writer pattern; create or replace keeps the trigger and the privileges). The consent is read
-- with the caller's rights: psychologist and admin may read consents (co_staff), the owner and the service role are not limited by RLS, and every
-- other role was refused ('forbidden') before this point.

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
    -- 0032: the invoice's patient must have a currently granted share_insurer consent (submission and every resubmission)
    if not exists (select 1 from invoices i join consents k on k.patient_id = i.patient_id
                    where i.id = new.invoice_id and k.purpose = 'share_insurer' and k.granted) then
      raise exception 'share_insurer_consent_required'; end if;
    new.submitted_at := now();
  end if;
  -- accepted after the scheme has already paid: if what was paid covers the approved (else claimed) amount, the claim is simply paid
  if tg_op = 'UPDATE' and new.status = 'accepted' and old.status is distinct from 'accepted' then
    if v_remitted > 0 and v_remitted >= coalesce(new.approved_cents, new.claimed_cents) then new.status := 'paid'; end if;
  end if;
  return new; end $$;
