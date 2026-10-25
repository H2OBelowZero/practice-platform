-- Pin search_path on the remaining helper/trigger functions flagged by the Supabase security advisor
-- (lint 0011 function_search_path_mutable). None of them is SECURITY DEFINER; this is hygiene so that
-- name resolution inside them can never depend on the caller's session search_path.
-- Extension-owned functions (btree_gist) are deliberately not touched.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
    where n.nspname = 'public'
      and d.objid is null
      and p.proname = any (array[
        'audit_log_guard','appt_no_delete','append_only_guard','fs_no_delete','consents_no_delete',
        'sa_today','_trusted_writer','_caller_trusted','_jwt_role','invoice_paid_cents',
        'invoices_no_delete','claims_no_delete','medical_aid_members_no_delete'])
      and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
  loop
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
  end loop;
end $$;

comment on view public.claim_summary is
  'Deliberately SECURITY DEFINER (advisor lint 0010 accepted): lets the bookkeeper see claim status and amounts only, '
  'with no ICD-10 codes, member or patient identity; rows are filtered by auth_role() (staff with aal2 only) and anon has no access.';
