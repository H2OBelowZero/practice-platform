-- supabase/migrations/0020_claims_fixes.sql
-- Task 14 fix round 1.
--  1. One scheme remittance advice (RA) number often pays several claims, but payments.gateway_ref is globally unique, so the second claim with the same RA number failed
--     (ref_conflict). record_scheme_remittance now stores the payment's gateway_ref as '<RA>#<claim id>' (unique per RA and claim) and keeps the plain RA number the user typed in
--     the new claim_payments.remittance_ref. Replay is per (claim, RA): same amount = no-op, another amount = ref_conflict; the same RA on another claim is a new payment.
--     A reference may not contain '#'. Existing rows are backfilled (their gateway_ref was the plain number). Nothing may show the composite: the UI uses remittance_ref, or the part before '#'.
--  2. What the scheme must pay is coalesce(approved_cents, claimed_cents): a claim short-paid against its approved amount closes as 'paid'. Accepting a part paid claim is
--     allowed (the scheme often pays before its advice arrives): it goes to 'paid' in that same transition when the remittances already cover the approved amount, otherwise to
--     'accepted'. One claim_events row per status change (written by claims_events from the stored status).
--  3. A claim cannot enter 'submitted' without at least one ICD-10 code ('icd10_required') or with an amount of zero ('claimed_amount_required'), for every writer.
--  4. Medical aid members are never deleted (trigger for every writer including the owner, and DELETE revoked from the API roles): end-date them.
-- claims_guard stays SECURITY INVOKER and keeps the trusted-writer pattern of 0005; record_scheme_remittance keeps its signature and R4 grants.

-- ---- 1. remittance reference per claim --------------------------------------------------------------------------------------------------
alter table claim_payments add column remittance_ref text check (remittance_ref is null or btrim(remittance_ref) <> '');
alter table claim_payments disable trigger trg_claim_payments_append_only; -- one-off backfill of the new column, then append-only again
update claim_payments cp set remittance_ref = p.gateway_ref from payments p where p.id = cp.payment_id and cp.remittance_ref is null;
alter table claim_payments enable trigger trg_claim_payments_append_only;
create unique index claim_payments_ref_once on claim_payments (claim_id, remittance_ref) where remittance_ref is not null;

-- ---- 2./3. claims_guard: approved-else-claimed basis on acceptance, part_paid -> accepted, icd10_required ----------------------------------------------
create or replace function claims_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare api boolean := not _trusted_writer(tg_relid);
        inv invoices; v_patient uuid; v_others int; v_remitted int;
begin
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
  if new.status = 'rejected' and nullif(btrim(coalesce(new.rejection_reason, '')), '') is null then raise exception 'rejection_reason_required'; end if;
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status is distinct from 'submitted') then
    if coalesce(array_length(new.icd10_codes, 1), 0) < 1 then raise exception 'icd10_required'; end if;
    if new.claimed_cents <= 0 then raise exception 'claimed_amount_required'; end if;
    new.submitted_at := now();
  end if;
  -- accepted after the scheme has already paid: if what was paid covers the approved (else claimed) amount, the claim is simply paid
  if tg_op = 'UPDATE' and new.status = 'accepted' and old.status is distinct from 'accepted' then
    select coalesce(sum(amount_cents), 0) into v_remitted from claim_payments where claim_id = new.id;
    if v_remitted > 0 and v_remitted >= coalesce(new.approved_cents, new.claimed_cents) then new.status := 'paid'; end if;
  end if;
  return new; end $$;

-- ---- 1./2. record_scheme_remittance ---------------------------------------------------------------------------------------------------------------
create or replace function record_scheme_remittance(p_claim uuid, p_amount int, p_ref text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c claims; ex claim_payments; pid uuid; got int; v_status text; v_basis int;
begin
  if auth.uid() is not null then
    if coalesce(auth_role()::text, '') not in ('psychologist','admin') then raise exception 'forbidden'; end if;
  elsif not (_jwt_role() = 'service_role' or _caller_trusted()) then
    raise exception 'forbidden'; -- no user and not the service role
  end if;
  p_ref := nullif(btrim(p_ref), '');
  if p_ref is null then raise exception 'ref_required'; end if;
  if position('#' in p_ref) > 0 then raise exception 'invalid_ref'; end if; -- '#' joins the reference and the claim id in payments.gateway_ref
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount'; end if;
  -- lock order is always claim, then invoice; both locks come before the replay check, so two concurrent submissions of one reference serialise
  select * into c from claims where id = p_claim for update;
  if not found then raise exception 'unknown_claim'; end if;
  perform 1 from invoices where id = c.invoice_id for update;
  -- replay: the same remittance advice number on the same claim. Same amount = nothing happens; another amount = conflict. Another claim may use the same number.
  select * into ex from claim_payments where claim_id = p_claim and remittance_ref = p_ref;
  if found then
    if ex.amount_cents = p_amount then return; end if;
    raise exception 'ref_conflict';
  end if;
  if c.status not in ('submitted','accepted','part_paid') then raise exception 'claim_not_payable'; end if;
  v_basis := coalesce(c.approved_cents, c.claimed_cents); -- what the scheme has to pay
  select coalesce(sum(amount_cents),0) into got from claim_payments where claim_id = p_claim;
  if got + p_amount > v_basis then raise exception 'remittance_exceeds_claim'; end if;
  pid := _record_payment(c.invoice_id, 'medical_aid', p_amount, p_ref || '#' || p_claim::text, auth.uid(), sa_today(), false, false);
  insert into claim_payments(claim_id,payment_id,amount_cents,remittance_ref) values (p_claim, pid, p_amount, p_ref);
  got := got + p_amount;
  v_status := case when got >= v_basis then 'paid' else 'part_paid' end;
  update claims set status = v_status, reconciled_at = now() where id = p_claim;
  insert into claim_events(claim_id,event,from_status,to_status,detail,actor)
  values (p_claim, 'remittance', c.status, v_status, jsonb_build_object('amount', p_amount, 'ref', p_ref), auth.uid());
  perform audit_write('claim.remittance', 'claims', p_claim,
    jsonb_build_object('amount', p_amount, 'ref', p_ref, 'invoice_id', c.invoice_id, 'payment_id', pid)); end $$;
revoke execute on function record_scheme_remittance(uuid, int, text) from public, anon;
grant execute on function record_scheme_remittance(uuid, int, text) to authenticated, service_role;

-- ---- 4. members are never deleted --------------------------------------------------------------------------------------------------------------------------
create function medical_aid_members_no_delete() returns trigger language plpgsql as
$$ begin raise exception 'members cannot be deleted; end-date instead'; end $$;
create trigger trg_mam_no_delete before delete on medical_aid_members for each row execute function medical_aid_members_no_delete();
revoke delete on medical_aid_members from authenticated, service_role;
revoke execute on function medical_aid_members_no_delete() from public, anon, authenticated, service_role;
