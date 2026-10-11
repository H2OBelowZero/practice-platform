-- supabase/migrations/0005_billing.sql
-- Billing and medical-aid claims. All money is integer cents.
--
-- Trust model used by the triggers below (fail closed): only superusers, postgres, supabase_admin and the owner of the table being
-- written are trusted; EVERY other role (anon, authenticated, service_role and anything added later) is held to every business rule.
-- The table owner (migrations, the security definer functions in this file, superuser test setup) is trusted, which is how
-- invoice_recompute() can set 'paid' and record_scheme_remittance() can set 'part_paid' while a direct UPDATE by any API
-- role cannot. Guard triggers that must tell the two apart are SECURITY INVOKER and test current_user (inside a security
-- definer function current_user is the owner, i.e. postgres). No session flag or GUC is used, so a caller cannot spoof the bypass.

-- Billing dates are South African dates, whatever the server's time zone.
create function sa_today() returns date language sql stable as $$ select (now() at time zone 'Africa/Johannesburg')::date $$;

-- Trust helpers (SECURITY INVOKER on purpose: they look at who is calling).
-- _trusted_writer: used inside guard triggers; current_user is the effective role (the owner inside a security definer function).
create function _trusted_writer(p_rel oid) returns boolean language sql stable as
$$ select current_user in ('postgres','supabase_admin')
       or coalesce((select rolsuper from pg_roles where rolname = current_user), false)
       or current_user = (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = p_rel) $$;
-- _caller_trusted: used inside security definer functions, where current_user is already the owner; the GUC 'role' still holds
-- the role the session switched to (PostgREST does SET ROLE), or 'none' for a direct connection, where session_user is the caller.
create function _caller_trusted() returns boolean language sql stable as
$$ select x.r in ('postgres','supabase_admin') or coalesce((select rolsuper from pg_roles where rolname = x.r), false)
   from (select case when current_setting('role') = 'none' then session_user::text else current_setting('role') end as r) x $$;
-- the role claim of the verified PostgREST JWT ('service_role' for the server-side key)
create function _jwt_role() returns text language sql stable as
$$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') $$;

create sequence invoice_seq start 1;
create table invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default 'INV-' || lpad(nextval('invoice_seq')::text, 5, '0'),
  patient_id uuid not null references patients, appointment_id uuid references appointments,
  issue_date date not null default sa_today(), due_date date not null default sa_today() + 14,
  status text not null default 'draft' check (status in ('draft','issued','part_paid','paid','void')),
  payer_type text not null default 'self' check (payer_type in ('self','medical_aid','split')),
  subtotal_cents int not null default 0 check (subtotal_cents >= 0),
  discount_cents int not null default 0 check (discount_cents >= 0),
  vat_cents int not null default 0 check (vat_cents >= 0),
  total_cents int not null default 0 check (total_cents >= 0),
  scheme_portion_cents int not null default 0 check (scheme_portion_cents >= 0),
  patient_portion_cents int not null default 0 check (patient_portion_cents >= 0),
  created_at timestamptz not null default now());
create table invoice_lines (id uuid primary key default gen_random_uuid(), invoice_id uuid not null references invoices,
  description text not null, quantity int not null default 1 check (quantity > 0), unit_cents int not null check (unit_cents >= 0), tariff_code text);
create table credit_notes (id uuid primary key default gen_random_uuid(), invoice_id uuid not null references invoices,
  amount_cents int not null check (amount_cents > 0), reason text not null, created_by uuid, created_at timestamptz not null default now());
create table payments (
  id uuid primary key default gen_random_uuid(), invoice_id uuid not null references invoices,
  method text not null check (method in ('payfast','eft','cash','card_machine','medical_aid')),
  -- gateway_ref: PayFast pf_payment_id / scheme remittance reference, globally unique, used ONLY for payfast and medical_aid.
  -- reference: the bank reference, card slip or receipt number of a manual payment (not unique: genuine repeats exist).
  gateway_ref text unique check (gateway_ref is null or btrim(gateway_ref) <> ''),
  reference text check (reference is null or btrim(reference) <> ''), amount_cents int not null check (amount_cents > 0),
  status text not null default 'succeeded' check (status in ('pending','succeeded','failed')),
  received_on date not null default sa_today(), -- the date the money arrived (manual payments may be back-dated, never future-dated)
  verified_at timestamptz default now(), recorded_by uuid, created_at timestamptz not null default now(), -- no gateway payload is stored
  constraint payments_ref_columns check ((method in ('payfast','medical_aid') and reference is null) or (method not in ('payfast','medical_aid') and gateway_ref is null)));

create table medical_aid_members (id uuid primary key default gen_random_uuid(), patient_id uuid not null references patients,
  scheme text not null, plan text, member_number text not null, dependant_code text, main_member_name text, valid_from date, valid_to date);
create table icd10_codes (code text primary key, description text not null);
insert into icd10_codes values ('F32.9','Depressive episode, unspecified'),('F41.1','Generalised anxiety disorder'),('F41.9','Anxiety disorder, unspecified'),
 ('F43.1','Post-traumatic stress disorder'),('F43.2','Adjustment disorders'),('F90.0','Attention-deficit hyperactivity disorder, inattentive'),('Z63.0','Problems in relationship with spouse or partner');
create table claims (id uuid primary key default gen_random_uuid(), invoice_id uuid not null references invoices, member_id uuid not null references medical_aid_members,
  preauth_ref text, claim_ref text, icd10_codes text[] not null default '{}', tariff_code text,
  status text not null default 'draft' check (status in ('draft','submitted','accepted','part_paid','rejected','paid')),
  submitted_at timestamptz, claimed_cents int not null default 0 check (claimed_cents >= 0), approved_cents int check (approved_cents >= 0 and approved_cents <= claimed_cents),
  rejection_reason text, reconciled_at timestamptz, created_at timestamptz not null default now());
create table claim_events (id bigserial primary key, claim_id uuid not null references claims, event text not null,
  from_status text, to_status text, detail jsonb, actor uuid, at timestamptz not null default now());
create table claim_payments (id uuid primary key default gen_random_uuid(), claim_id uuid not null references claims, payment_id uuid not null references payments,
  amount_cents int not null check (amount_cents > 0), unique (claim_id, payment_id), unique (payment_id));

-- ---- invoices -------------------------------------------------------------------------------------------------------------
-- Invoker helper, RLS-limited like any other read. (The internal sums below run as the owner.)
create function invoice_paid_cents(p_invoice uuid) returns int language sql stable as
$$ select coalesce(sum(amount_cents),0)::int from payments where invoice_id = p_invoice and status = 'succeeded' $$;

-- Lifecycle and freezing of invoices (SECURITY INVOKER on purpose, see the trust model at the top).
--   * Untrusted roles may only create drafts, and move draft->issued, issued->void, draft->void by hand. part_paid / paid come
--     only from invoice_recompute(). Nothing ever leaves 'void' and nothing goes back to 'draft'.
--   * Becoming issued (any role) needs a non-zero total, scheme + patient portion = total, and no scheme portion for self-pay;
--     the DB stamps issue_date = today at that moment.
--   * The invoice number is frozen always. Once not a draft, the money fields (and the payer type, which decides claim
--     eligibility) are frozen as well; due_date stays editable. A void is refused when a succeeded payment exists (untrusted
--     roles) and, for everyone, while a claim is submitted / accepted / part_paid / paid.
create function invoices_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare api boolean := not _trusted_writer(tg_relid);
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
    if tg_op = 'UPDATE' then new.issue_date := sa_today(); end if;
  end if;
  return new; end $$;
create trigger trg_invoices_guard before insert or update on invoices for each row execute function invoices_guard();

-- issuing and voiding leave an audit row, once each (also for the automatic void of a fully credited, unpaid invoice)
create function invoices_after() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status then
    if old.status = 'draft' and new.status = 'issued' then
      perform audit_write('invoice.issue', 'invoices', new.id, jsonb_build_object('number', new.number, 'total_cents', new.total_cents, 'payer_type', new.payer_type));
    elsif new.status = 'void' then
      perform audit_write('invoice.void', 'invoices', new.id, jsonb_build_object('number', new.number, 'from_status', old.status));
    end if;
  end if;
  return null; end $$;
create trigger trg_invoices_after after update on invoices for each row execute function invoices_after();

-- invoices are legal records: void, never delete (privileges are also revoked below)
create function invoices_no_delete() returns trigger language plpgsql as
$$ begin raise exception 'invoices cannot be deleted; void instead'; end $$;
create trigger trg_invoices_no_delete before delete on invoices for each row execute function invoices_no_delete();

-- lines belong to a draft only; reads the parent as the owner so RLS never hides a non-draft parent
create function invoice_lines_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare st text;
begin
  -- before any invoice is looked at (a BEFORE trigger runs ahead of the RLS check)
  if auth.uid() is not null and coalesce(auth_role()::text, '') not in ('psychologist','admin') then raise exception 'forbidden'; end if;
  if tg_op in ('UPDATE','DELETE') then
    select status into st from invoices where id = old.invoice_id;
    if found and st <> 'draft' then raise exception 'invoice_lines_frozen'; end if;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    select status into st from invoices where id = new.invoice_id;
    if found and st <> 'draft' then raise exception 'invoice_lines_frozen'; end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end; end $$;
create trigger trg_invoice_lines_guard before insert or update or delete on invoice_lines for each row execute function invoice_lines_guard();

-- ---- status recompute -----------------------------------------------------------------------------------------------------
-- The only writer of 'part_paid' / 'paid' (and of the automatic 'void' for a fully credited unpaid invoice).
-- paid > 0 and paid >= total - credits -> paid; paid > 0 -> part_paid; fully credited with nothing paid -> void; else unchanged.
create function invoice_recompute(p_invoice uuid) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; credits int; paid int; v_new text;
begin
  select * into inv from invoices where id = p_invoice;
  if not found or inv.status in ('draft','void') then return; end if;
  select coalesce(sum(amount_cents),0) into credits from credit_notes where invoice_id = p_invoice;
  paid := invoice_paid_cents(p_invoice);
  v_new := case
    when paid > 0 and paid >= inv.total_cents - credits then 'paid'
    when paid > 0 then 'part_paid'
    when credits > 0 and credits >= inv.total_cents then 'void'
    else inv.status end;
  if v_new <> inv.status then update invoices set status = v_new where id = p_invoice; end if; end $$;

-- ---- payments --------------------------------------------------------------------------------------------------------------
-- Runs for every insert, whoever inserts. The invoice row is locked first (select ... for update) so two concurrent payments
-- on one invoice are serialised: the second waits, then sums the first, and cannot push the total past what is owed.
create function payments_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; credits int; paid int;
begin
  select * into inv from invoices where id = new.invoice_id for update;
  if not found then raise exception 'unknown_invoice'; end if;
  if inv.status not in ('issued','part_paid') then raise exception 'invoice_not_payable'; end if;
  if new.status = 'succeeded' then
    select coalesce(sum(amount_cents),0) into credits from credit_notes where invoice_id = inv.id;
    select coalesce(sum(amount_cents),0) into paid from payments where invoice_id = inv.id and status = 'succeeded';
    if paid + new.amount_cents > inv.total_cents - credits then raise exception 'overpay'; end if;
  end if;
  return new; end $$;
create trigger trg_payments_guard before insert on payments for each row execute function payments_guard();

create function payments_after() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin perform invoice_recompute(new.invoice_id); return null; end $$;
create trigger trg_payments_after after insert on payments for each row execute function payments_after();

-- payments and credit notes are a ledger: append-only even for the owner (privileges are also revoked below)
create trigger trg_payments_append_only before update or delete on payments for each row execute function append_only_guard();
create trigger trg_credit_notes_append_only before update or delete on credit_notes for each row execute function append_only_guard();
create trigger trg_claim_events_append_only before update or delete on claim_events for each row execute function append_only_guard();
create trigger trg_claim_payments_append_only before update or delete on claim_payments for each row execute function append_only_guard();

-- Internal. The one place a payment row is created. Not executable by any API role; only the public wrappers call it.
--   * payfast / medical_aid: the reference goes to gateway_ref (globally unique). Only the service-role path (p_replay_ok, the
--     PayFast ITN route, which the gateway retries) treats the same ref for the same invoice, amount and method as a replay and
--     returns the existing id; anything else with that ref is 'ref_conflict' (or 'duplicate_ref' when replays are not allowed).
--   * manual methods: the reference goes to reference (not unique). Double-submit protection instead: the same invoice, method,
--     amount, reference and received_on is 'possible_duplicate' unless p_allow_duplicate.
-- The invoice is locked before any lookup, so a concurrent duplicate waits for the first insert and then finds it
-- (the unique_violation handler covers a gateway duplicate that still slips through, e.g. the same ref on another invoice).
create function _record_payment(p_invoice uuid, p_method text, p_amount int, p_ref text, p_by uuid, p_received_on date,
                                p_replay_ok boolean, p_allow_duplicate boolean) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare pid uuid; ex payments; gw boolean := p_method in ('payfast','medical_aid');
begin
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount'; end if;
  perform 1 from invoices where id = p_invoice for update;
  if not found then raise exception 'unknown_invoice'; end if;
  if gw then
    select * into ex from payments where gateway_ref = p_ref;
    if found then
      if not p_replay_ok then raise exception 'duplicate_ref'; end if;
      if ex.invoice_id = p_invoice and ex.amount_cents = p_amount and ex.method = p_method then return ex.id; end if;
      raise exception 'ref_conflict';
    end if;
  elsif not p_allow_duplicate and exists (select 1 from payments where invoice_id = p_invoice and method = p_method and amount_cents = p_amount
                                          and reference is not distinct from p_ref and received_on = p_received_on) then
    raise exception 'possible_duplicate';
  end if;
  begin
    insert into payments(invoice_id,method,gateway_ref,reference,amount_cents,received_on,recorded_by)
    values (p_invoice, p_method, case when gw then p_ref end, case when not gw then p_ref end, p_amount, p_received_on, p_by) returning id into pid;
  exception when unique_violation then
    select * into ex from payments where gateway_ref = p_ref;
    if not p_replay_ok then raise exception 'duplicate_ref'; end if;
    if found and ex.invoice_id = p_invoice and ex.amount_cents = p_amount and ex.method = p_method then return ex.id; end if;
    raise exception 'ref_conflict';
  end;
  perform audit_write('payment.record', 'payments', pid,
    jsonb_build_object('invoice_id', p_invoice, 'method', p_method, 'amount', p_amount, 'ref', p_ref, 'received_on', p_received_on));
  return pid; end $$;

-- User session: psychologist/admin recording a manual payment (eft, cash, card machine); recorded_by is the caller, p_by ignored.
-- eft and card_machine must carry a reference (cash may); received_on may be back-dated but never in the future (SA date).
-- Service role (JWT role 'service_role', i.e. the PayFast ITN route) or a trusted connection: payfast only, with the gateway
-- reference. Any other session without a user (e.g. a custom login role with no JWT) is refused.
create function record_payment(p_invoice uuid, p_method text, p_amount int, p_ref text, p_by uuid, p_received_on date default sa_today(),
                               p_allow_duplicate boolean default false) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_by uuid; v_on date := coalesce(p_received_on, sa_today()); v_service boolean := false;
begin
  p_ref := nullif(btrim(p_ref), '');
  if auth.uid() is not null then
    if coalesce(auth_role()::text, '') not in ('psychologist','admin') then raise exception 'forbidden'; end if;
    if p_method is null or p_method not in ('eft','cash','card_machine') then raise exception 'invalid_method'; end if;
    if p_method in ('eft','card_machine') and p_ref is null then raise exception 'ref_required'; end if;
    v_by := auth.uid();
  else
    if not (_jwt_role() = 'service_role' or _caller_trusted()) then raise exception 'forbidden'; end if;
    if p_method is distinct from 'payfast' then raise exception 'invalid_method'; end if;
    if p_ref is null then raise exception 'ref_required'; end if;
    v_by := p_by; v_service := true; p_allow_duplicate := false;
  end if;
  if v_on > sa_today() then raise exception 'future_date'; end if;
  return _record_payment(p_invoice, p_method, p_amount, p_ref, v_by, v_on, v_service, p_allow_duplicate); end $$;

-- ---- credit notes ---------------------------------------------------------------------------------------------------------
-- Psychologist-only insert (RLS), validated here: only issued / part_paid invoices, never more than is outstanding.
create function credit_notes_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare inv invoices; credits int; paid int;
begin
  -- before any invoice is looked at (a BEFORE trigger runs ahead of the RLS check): psychologist only
  if auth.uid() is not null and coalesce(auth_role()::text, '') <> 'psychologist' then raise exception 'forbidden'; end if;
  new.created_by := auth.uid();
  if nullif(btrim(new.reason), '') is null then raise exception 'reason_required'; end if;
  select * into inv from invoices where id = new.invoice_id for update;
  if not found then raise exception 'unknown_invoice'; end if;
  if inv.status not in ('issued','part_paid') then raise exception 'invoice_not_creditable'; end if;
  select coalesce(sum(amount_cents),0) into credits from credit_notes where invoice_id = inv.id;
  paid := invoice_paid_cents(inv.id);
  if credits + paid + new.amount_cents > inv.total_cents then raise exception 'credit_exceeds_outstanding'; end if;
  return new; end $$;
create trigger trg_credit_notes_guard before insert on credit_notes for each row execute function credit_notes_guard();

create function credit_notes_after() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform invoice_recompute(new.invoice_id);
  perform audit_write('credit_note.create', 'credit_notes', new.id,
    jsonb_build_object('invoice_id', new.invoice_id, 'amount', new.amount_cents, 'reason', new.reason));
  return null; end $$;
create trigger trg_credit_notes_after after insert on credit_notes for each row execute function credit_notes_after();

-- ---- medical aid & claims -------------------------------------------------------------------------------------------------
create function medical_aid_members_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.patient_id is distinct from old.patient_id and exists (select 1 from claims where member_id = old.id) then
    raise exception 'member_in_use'; end if;
  return new; end $$;
create trigger trg_mam_guard before update on medical_aid_members for each row execute function medical_aid_members_guard();

-- Claim rules (SECURITY INVOKER, same trust model as invoices).
--   * Untrusted roles create drafts only, and may only make the moves draft->submitted, submitted->accepted|rejected,
--     accepted|rejected->submitted (resubmission), rejected->draft. part_paid / paid come only from record_scheme_remittance.
--   * Claims are written only while the invoice is issued or part_paid, the invoice is medical_aid/split, the member is the
--     invoice patient's, and claimed_cents fit the scheme portion: each claim alone, and cumulatively over the invoice's claims
--     that are not rejected. The invoice row is locked so concurrent claim writes serialise.
--   * invoice_id is frozen. Once a claim has left draft, member_id, claimed_cents, icd10_codes and tariff_code are frozen until
--     it is back in draft (only the rejected->draft path). submitted_at is stamped here on every (re)submission, reconciled_at
--     is set by the remittance function only.
--   * ICD-10 codes must exist in icd10_codes and only the psychologist may write them (admin manages the rest of the claim).
--   * A rejection needs a reason (every role).
create function claims_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare api boolean := not _trusted_writer(tg_relid);
        inv invoices; v_patient uuid; v_others int;
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
           ('draft','submitted'),('submitted','accepted'),('submitted','rejected'),('accepted','submitted'),('rejected','submitted'),('rejected','draft')) then
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
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status is distinct from 'submitted') then new.submitted_at := now(); end if;
  return new; end $$;
create trigger trg_claims_guard before insert or update on claims for each row execute function claims_guard();

create function claims_no_delete() returns trigger language plpgsql as
$$ begin raise exception 'claims cannot be deleted'; end $$;
create trigger trg_claims_no_delete before delete on claims for each row execute function claims_no_delete();

-- event log (status changes with from/to and actor) plus one follow-up task per rejection
create function claims_events() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into claim_events(claim_id,event,from_status,to_status,detail,actor)
    values (new.id, 'status:'||new.status, case when tg_op = 'UPDATE' then old.status end, new.status,
            case when new.status = 'rejected' then jsonb_build_object('reason', new.rejection_reason) end, auth.uid());
  end if;
  if new.status = 'rejected' and (tg_op = 'INSERT' or old.status <> 'rejected') then
    insert into tasks(title,priority,patient_id,source)
    select 'Claim rejected: follow up and resubmit', 'high', i.patient_id, 'claim_rejected' from invoices i where i.id = new.invoice_id;
  end if;
  return null; end $$;
create trigger trg_claims_events after insert or update on claims for each row execute function claims_events();

-- Staff (psychologist/admin, or the service role) records money the scheme paid against a claim. The invoice only ever moves
-- through the payment this creates. Idempotent on p_ref: a replay returns before touching anything (no second claim_payments
-- row, no status change), even after the claim is fully paid.
create function record_scheme_remittance(p_claim uuid, p_amount int, p_ref text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c claims; ex payments; pid uuid; got int; v_status text;
begin
  if auth.uid() is not null then
    if coalesce(auth_role()::text, '') not in ('psychologist','admin') then raise exception 'forbidden'; end if;
  elsif not (_jwt_role() = 'service_role' or _caller_trusted()) then
    raise exception 'forbidden'; -- no user and not the service role
  end if;
  p_ref := nullif(btrim(p_ref), '');
  if p_ref is null then raise exception 'ref_required'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_amount'; end if;
  -- lock order is always claim, then invoice (an UPDATE on claims has the claim row locked before claims_guard locks the invoice),
  -- and both locks come before the replay check, so two concurrent submissions of one ref serialise: the second sees the first
  select * into c from claims where id = p_claim for update;
  if not found then raise exception 'unknown_claim'; end if;
  perform 1 from invoices where id = c.invoice_id for update;
  select * into ex from payments where gateway_ref = p_ref;
  if found then
    if exists (select 1 from claim_payments where claim_id = p_claim and payment_id = ex.id) and ex.amount_cents = p_amount then return; end if;
    raise exception 'ref_conflict'; -- the ref belongs to another claim or invoice, or to a different amount
  end if;
  if c.status not in ('submitted','accepted','part_paid') then raise exception 'claim_not_payable'; end if;
  select coalesce(sum(amount_cents),0) into got from claim_payments where claim_id = p_claim;
  if got + p_amount > c.claimed_cents then raise exception 'remittance_exceeds_claim'; end if;
  pid := _record_payment(c.invoice_id, 'medical_aid', p_amount, p_ref, auth.uid(), sa_today(), false, false);
  insert into claim_payments(claim_id,payment_id,amount_cents) values (p_claim, pid, p_amount);
  got := got + p_amount;
  v_status := case when got >= c.claimed_cents then 'paid' else 'part_paid' end;
  update claims set status = v_status, reconciled_at = now() where id = p_claim;
  insert into claim_events(claim_id,event,from_status,to_status,detail,actor)
  values (p_claim, 'remittance', c.status, v_status, jsonb_build_object('amount', p_amount, 'ref', p_ref), auth.uid());
  perform audit_write('claim.remittance', 'claims', p_claim,
    jsonb_build_object('amount', p_amount, 'ref', p_ref, 'invoice_id', c.invoice_id, 'payment_id', pid)); end $$;

-- The patient themself, or a current guardian holding permissions.pay (patient-side reads of billing data).
-- Staff are covered by their own policies.
create function can_access_billing(p_patient uuid) returns boolean language sql stable security definer set search_path = public, pg_temp as
$$ select exists (select 1 from patients where id = p_patient and user_id = auth.uid())
       or exists (select 1 from guardianships where patient_id = p_patient and guardian_user_id = auth.uid()
                  and valid_from <= sa_today() and (valid_to is null or valid_to >= sa_today())
                  and permissions ->> 'pay' = 'true') $$;

-- ---- RLS ---------------------------------------------------------------------------------------------------------------------
alter table invoices enable row level security; alter table invoice_lines enable row level security; alter table credit_notes enable row level security;
alter table payments enable row level security; alter table medical_aid_members enable row level security; alter table icd10_codes enable row level security;
alter table claims enable row level security; alter table claim_events enable row level security; alter table claim_payments enable row level security;

-- invoices: psychologist/admin write, bookkeeper read-only, patients and current guardians read their own, nobody deletes
create policy inv_staff_read on invoices for select to authenticated using (auth_role() in ('psychologist','admin','bookkeeper'));
create policy inv_own on invoices for select to authenticated using (status <> 'draft' and can_access_billing(patient_id));
create policy inv_ins on invoices for insert to authenticated with check (auth_role() in ('psychologist','admin'));
create policy inv_upd on invoices for update to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy il_staff_read on invoice_lines for select to authenticated using (auth_role() in ('psychologist','admin','bookkeeper'));
create policy il_own on invoice_lines for select to authenticated using (invoice_id in (select id from invoices where status <> 'draft' and can_access_billing(patient_id)));
create policy il_ins on invoice_lines for insert to authenticated with check (auth_role() in ('psychologist','admin'));
create policy il_upd on invoice_lines for update to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy il_del on invoice_lines for delete to authenticated using (auth_role() in ('psychologist','admin'));
-- credit notes: psychologist inserts; staff, bookkeeper and the invoice's patient/guardian read
create policy cr_read on credit_notes for select to authenticated using (auth_role() in ('psychologist','admin','bookkeeper'));
create policy cr_own on credit_notes for select to authenticated using (invoice_id in (select id from invoices where status <> 'draft' and can_access_billing(patient_id)));
create policy cr_ins on credit_notes for insert to authenticated with check (auth_role() = 'psychologist');
-- payments: read only; rows come from record_payment / record_scheme_remittance
create policy pay_staff_read on payments for select to authenticated using (auth_role() in ('psychologist','admin','bookkeeper'));
create policy pay_own on payments for select to authenticated using (invoice_id in (select id from invoices where status <> 'draft' and can_access_billing(patient_id)));
-- medical aid: members are staff-managed (bookkeeper never sees member identity); ICD-10 reference data for clinicians only
create policy mam_staff on medical_aid_members for all to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy mam_own on medical_aid_members for select to authenticated using (can_access_billing(patient_id));
create policy icd_read on icd10_codes for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy cl_sel on claims for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy cl_ins on claims for insert to authenticated with check (auth_role() in ('psychologist','admin'));
create policy cl_upd on claims for update to authenticated using (auth_role() in ('psychologist','admin')) with check (auth_role() in ('psychologist','admin'));
create policy ce_staff on claim_events for select to authenticated using (auth_role() in ('psychologist','admin'));
create policy cp_staff on claim_payments for select to authenticated using (auth_role() in ('psychologist','admin','bookkeeper'));

-- The bookkeeper sees claim amounts and statuses only, via a view that omits codes, member and patient identity.
-- The view runs as its owner, so (a) it is a security barrier: a caller's own predicates cannot be evaluated against claims rows
-- before the role filter, and (b) it is read-only: an auto-updatable view with owner rights would let any role with write
-- privileges bypass the claims policies, so every privilege except SELECT-for-authenticated is revoked.
create view claim_summary with (security_invoker = false, security_barrier = true) as
  select c.id, c.invoice_id, c.status, c.claimed_cents, c.approved_cents, c.submitted_at from claims c
  where auth_role() in ('psychologist','admin','bookkeeper');
revoke all on claim_summary from anon, authenticated, service_role;
grant select on claim_summary to authenticated;

-- ---- privileges --------------------------------------------------------------------------------------------------------------
revoke all on invoices, invoice_lines, credit_notes, payments, medical_aid_members, icd10_codes, claims, claim_events, claim_payments from anon;
revoke all on sequence invoice_seq from anon;
revoke delete on invoices, claims from authenticated, service_role;
revoke insert, update, delete on payments, claim_events, claim_payments, icd10_codes from authenticated, service_role;
revoke update, delete on credit_notes from authenticated, service_role;
revoke insert on credit_notes from service_role; -- psychologist-only, through a user session

-- function privileges (ruling R4). Public entry points: callable by signed-in users and the service role. Internal and trigger
-- functions: callable by nobody through the API (they run as the owner from the triggers and the functions above).
revoke execute on function invoice_paid_cents(uuid) from public, anon;
revoke execute on function record_payment(uuid, text, int, text, uuid, date, boolean) from public, anon;
grant execute on function record_payment(uuid, text, int, text, uuid, date, boolean) to authenticated, service_role;
revoke execute on function can_access_billing(uuid) from public, anon;
grant execute on function can_access_billing(uuid) to authenticated, service_role;
revoke execute on function invoices_after() from public, anon, authenticated, service_role;
revoke execute on function record_scheme_remittance(uuid, int, text) from public, anon;
grant execute on function record_scheme_remittance(uuid, int, text) to authenticated, service_role;
revoke execute on function _record_payment(uuid, text, int, text, uuid, date, boolean, boolean) from public, anon, authenticated, service_role;
revoke execute on function invoice_recompute(uuid) from public, anon, authenticated, service_role;
revoke execute on function invoice_lines_guard() from public, anon, authenticated, service_role;
revoke execute on function payments_guard() from public, anon, authenticated, service_role;
revoke execute on function payments_after() from public, anon, authenticated, service_role;
revoke execute on function credit_notes_guard() from public, anon, authenticated, service_role;
revoke execute on function credit_notes_after() from public, anon, authenticated, service_role;
revoke execute on function claims_events() from public, anon, authenticated, service_role;
