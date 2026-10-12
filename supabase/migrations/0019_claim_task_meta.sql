-- supabase/migrations/0019_claim_task_meta.sql
-- Task 14. The follow-up task a claim rejection creates now carries tasks.meta = {"claim_id": <uuid>} (0013 added the column), so the tasks page can
-- link straight to /app/claims/<claim id> instead of the patient's billing tab. Everything else about it is unchanged: one task per rejection
-- (a second rejection after a resubmission is a second task; editing a rejected claim creates none), source 'claim_rejected', priority high,
-- patient_id from the invoice, and a fixed title: no rejection reason, ICD-10 code, scheme or member number ever goes into a task (the reason stays
-- in claim_events.detail and claims.rejection_reason, which only psychologist and admin can read).
-- The task is an ordinary staff task (its source does not match 'risk_flag:%', see 0013), so psychologist and admin both see it.
-- Tasks created before this migration have no meta; the app falls back to the patient's billing tab for them.
--
-- Same function as 0005 (security definer, owner rights, so it can write claim_events and tasks for any caller) with only the task insert changed.

create or replace function claims_events() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into claim_events(claim_id,event,from_status,to_status,detail,actor)
    values (new.id, 'status:'||new.status, case when tg_op = 'UPDATE' then old.status end, new.status,
            case when new.status = 'rejected' then jsonb_build_object('reason', new.rejection_reason) end, auth.uid());
  end if;
  if new.status = 'rejected' and (tg_op = 'INSERT' or old.status <> 'rejected') then
    insert into tasks(title,priority,patient_id,source,meta)
    select 'Claim rejected: follow up and resubmit', 'high', i.patient_id, 'claim_rejected', jsonb_build_object('claim_id', new.id)
      from invoices i where i.id = new.invoice_id;
  end if;
  return null; end $$;
revoke execute on function claims_events() from public, anon, authenticated, service_role;
