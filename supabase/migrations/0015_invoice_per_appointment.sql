-- supabase/migrations/0015_invoice_per_appointment.sql
-- Task 13b (staff billing UI).
--  1. One live invoice per appointment: a second non-void invoice for the same appointment is refused by a unique partial index.
--     A void invoice frees the appointment (it can be invoiced again). Manual invoices (appointment_id null) are unrestricted.
--  2. invoice_balances: one row per invoice with paid / credited / outstanding in integer cents (SECURITY INVOKER view: the caller's
--     RLS applies, so the bookkeeper sees every invoice, a patient only their own issued ones). It carries no patient name.
--  3. billing_totals(...): the totals strip of the staff billing list for the same filters, summed in the database (exact, no row cap).
--  4. billing_open_by_due_date(): open balances grouped by due date, for the ageing summary (the app puts the dates into buckets).
--  5. create_invoice_draft / save_invoice_draft: SECURITY INVOKER, so every RLS policy and guard trigger of 0005 still applies to the
--     caller; they exist so the invoice row and ALL its lines are written in ONE transaction (PostgREST cannot do that from the app), and
--     so the late-cancellation fee task is closed in the same transaction as the invoice that settles it.

create unique index invoices_one_live_per_appointment on invoices (appointment_id) where appointment_id is not null and status <> 'void';

-- lines keep the order they were typed in (set by _insert_invoice_lines; existing rows all have 0)
alter table invoice_lines add column position int not null default 0;

-- ---- balances -------------------------------------------------------------------------------------------------------------
-- outstanding only exists for an invoice that can still be paid (issued / part_paid); draft, paid and void owe nothing.
create view invoice_balances with (security_invoker = true) as
  select i.id, i.number, i.patient_id, i.appointment_id, i.status, i.payer_type, i.issue_date, i.due_date, i.created_at,
         i.total_cents, i.scheme_portion_cents, i.patient_portion_cents,
         coalesce(p.paid, 0)::int as paid_cents, coalesce(c.credit, 0)::int as credit_cents,
         case when i.status in ('issued','part_paid') then greatest(0, i.total_cents - coalesce(c.credit, 0) - coalesce(p.paid, 0))::int else 0 end as outstanding_cents
  from invoices i
  left join (select invoice_id, sum(amount_cents) as paid from payments where status = 'succeeded' group by invoice_id) p on p.invoice_id = i.id
  left join (select invoice_id, sum(amount_cents) as credit from credit_notes group by invoice_id) c on c.invoice_id = i.id;
revoke all on invoice_balances from anon, authenticated, service_role;
grant select on invoice_balances to authenticated, service_role;

-- Totals for a filtered list. invoiced / credited / received count issued, part_paid and paid invoices only (a draft is not yet
-- invoiced, a void one is cancelled); outstanding is the sum of the per-invoice balances. p_overdue = due before p_today and still open.
create function billing_totals(p_status text default null, p_payer text default null, p_overdue boolean default false,
                               p_q text default null, p_today date default sa_today())
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
    and (not coalesce(p_overdue, false) or (b.due_date < p_today and b.status in ('issued','part_paid')))
    and (nullif(p_q, '') is null or b.number ilike '%' || replace(replace(replace(p_q, '\', '\\'), '%', '\%'), '_', '\_') || '%') $$;

-- Open balances per due date (one row per distinct due date, so a practice never gets near any row limit).
create function billing_open_by_due_date() returns table (due_date date, n bigint, outstanding_cents bigint)
language sql stable set search_path = public, pg_temp as $$
  select b.due_date, count(*), sum(b.outstanding_cents)::bigint from invoice_balances b
  where b.status in ('issued','part_paid') and b.outstanding_cents > 0 group by b.due_date order by b.due_date $$;

-- ---- atomic draft writes --------------------------------------------------------------------------------------------------
-- The app computes the figures (lib/billing/invoice.ts, VAT from the practice settings); this only refuses figures that do not add up:
-- lines sum to the subtotal, discount within the subtotal, subtotal - discount + VAT = total, portions sum to the total.
create function _invoice_math_check(p_invoice uuid) returns void language plpgsql set search_path = public, pg_temp as $$
declare i invoices; s bigint;
begin
  select * into i from invoices where id = p_invoice;
  select coalesce(sum(quantity::bigint * unit_cents), 0) into s from invoice_lines where invoice_id = p_invoice;
  if s <> i.subtotal_cents or i.discount_cents > i.subtotal_cents
     or i.subtotal_cents - i.discount_cents + i.vat_cents <> i.total_cents
     or i.scheme_portion_cents + i.patient_portion_cents <> i.total_cents then
    raise exception 'totals_mismatch'; end if;
end $$;

-- p_lines: [{description, quantity, unit_cents}], at least one, each 1..99 x a non-negative price with a 1..200 character description.
create function _insert_invoice_lines(p_invoice uuid, p_lines jsonb) returns void language plpgsql set search_path = public, pg_temp as $$
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'lines_required'; end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(description text, quantity int, unit_cents int)
             where x.description is null or btrim(x.description) = '' or length(x.description) > 200
                or x.quantity is null or x.quantity not between 1 and 99 or x.unit_cents is null or x.unit_cents < 0) then
    raise exception 'invalid_line'; end if;
  insert into invoice_lines(invoice_id, description, quantity, unit_cents, position)
  select p_invoice, btrim(e.o ->> 'description'), (e.o ->> 'quantity')::int, (e.o ->> 'unit_cents')::int, e.n::int from jsonb_array_elements(p_lines) with ordinality as e(o, n);
end $$;

-- A new DRAFT invoice with its lines. From an appointment: the appointment must be the patient's and attended (or cancelled with the
-- patient's open late-cancellation fee task named in p_task, which is closed here, in the same transaction). One live invoice per
-- appointment is the unique index above. Returns the invoice id.
create function create_invoice_draft(p_patient uuid, p_appointment uuid, p_task uuid, p_due date, p_payer text,
  p_subtotal int, p_discount int, p_vat int, p_total int, p_scheme int, p_patient_portion int, p_lines jsonb) returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare a appointments; v_id uuid;
begin
  if p_appointment is not null then
    select * into a from appointments where id = p_appointment;
    if not found then raise exception 'unknown_appointment'; end if;
    if a.patient_id <> p_patient then raise exception 'appointment_patient_mismatch'; end if;
    if a.status <> 'attended' and not (a.status = 'cancelled' and p_task is not null) then raise exception 'appointment_not_billable'; end if;
  elsif p_task is not null then
    raise exception 'task_not_open';
  end if;
  if p_task is not null then
    update tasks set status = 'done'
     where id = p_task and source = 'late_cancel_fee' and status = 'open' and appointment_id = p_appointment and patient_id = p_patient;
    if not found then raise exception 'task_not_open'; end if;
  end if;
  insert into invoices(patient_id, appointment_id, due_date, payer_type, subtotal_cents, discount_cents, vat_cents, total_cents,
                       scheme_portion_cents, patient_portion_cents)
  values (p_patient, p_appointment, p_due, p_payer, p_subtotal, p_discount, p_vat, p_total, p_scheme, p_patient_portion) returning id into v_id;
  perform _insert_invoice_lines(v_id, p_lines);
  perform _invoice_math_check(v_id);
  return v_id;
end $$;

-- Replace everything editable on a DRAFT (due date, payer type, figures, all lines) in one transaction. The 0005 guards still decide
-- who may do it and refuse a non-draft invoice; 'invoice_not_draft' covers the missing / already issued / void cases up front.
create function save_invoice_draft(p_invoice uuid, p_due date, p_payer text, p_subtotal int, p_discount int, p_vat int, p_total int,
  p_scheme int, p_patient_portion int, p_lines jsonb) returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  update invoices set due_date = p_due, payer_type = p_payer, subtotal_cents = p_subtotal, discount_cents = p_discount, vat_cents = p_vat,
         total_cents = p_total, scheme_portion_cents = p_scheme, patient_portion_cents = p_patient_portion
   where id = p_invoice and status = 'draft';
  if not found then raise exception 'invoice_not_draft'; end if;
  delete from invoice_lines where invoice_id = p_invoice;
  perform _insert_invoice_lines(p_invoice, p_lines);
  perform _invoice_math_check(p_invoice);
end $$;

revoke execute on function billing_totals(text, text, boolean, text, date) from public, anon;
grant execute on function billing_totals(text, text, boolean, text, date) to authenticated, service_role;
revoke execute on function billing_open_by_due_date() from public, anon;
grant execute on function billing_open_by_due_date() to authenticated, service_role;
-- the two helpers are SECURITY INVOKER and run as the calling user, so that user needs EXECUTE; they only read and write under that user's RLS
revoke execute on function _invoice_math_check(uuid) from public, anon;
grant execute on function _invoice_math_check(uuid) to authenticated;
revoke execute on function _insert_invoice_lines(uuid, jsonb) from public, anon;
grant execute on function _insert_invoice_lines(uuid, jsonb) to authenticated;
revoke execute on function create_invoice_draft(uuid, uuid, uuid, date, text, int, int, int, int, int, int, jsonb) from public, anon;
grant execute on function create_invoice_draft(uuid, uuid, uuid, date, text, int, int, int, int, int, int, jsonb) to authenticated;
revoke execute on function save_invoice_draft(uuid, date, text, int, int, int, int, int, int, jsonb) from public, anon;
grant execute on function save_invoice_draft(uuid, date, text, int, int, int, int, int, int, jsonb) to authenticated;
