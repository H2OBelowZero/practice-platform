-- supabase/migrations/0030_staff_mfa_in_db.sql
-- Final review C1 (R50). Staff two-step sign-in (TOTP, JWT claim aal = 'aal2') was enforced only by the Next.js pages (lib/auth/session.ts).
-- A password-only (aal1) access token, obtained with signInWithPassword and the PUBLIC anon key, could call PostgREST directly and read
-- whatever the staff role's policies allow (clinical notes, forms, invoices, the audit log ...).
--
-- auth_role() is the one place every policy, view and SECURITY DEFINER guard asks "which application role is calling?" (directly, or through
-- is_staff(), is_booking_staff(), staff_form_access(), claim_summary, the report_* role guards and the trigger guards). From now on it answers
-- NULL for a staff role (psychologist, admin, bookkeeper, associate) unless the verified JWT says aal2. NULL matches no policy and no role list, so an
-- aal1 staff token is treated like a signed-in user with no role: it reads only what any user may read about themselves (its own profile row, through
-- profiles_self's `user_id = auth.uid()` branch, which lib/auth/session.ts currentUser() needs to send staff to /mfa) and every staff function refuses it.
-- Patients and guardians are unaffected (their access never depended on aal). The service role and the owner (no auth.uid()) are unaffected: no profile.
--
-- The aal claim is read with auth.jwt() (Supabase's accessor for the verified claims), falling back to request.jwt.claims for older PostgREST
-- settings. The only other direct read of profiles.role in the database is ensure_patient_record() (0008), which requires role 'patient', so it needs
-- no aal rule. Grants are re-stated (R4).

create or replace function auth_role() returns role_t language sql stable security definer set search_path = public, pg_temp as $$
  select case
           when p.role in ('psychologist', 'admin', 'bookkeeper', 'associate')
                and coalesce(auth.jwt() ->> 'aal', nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', '') <> 'aal2'
             then null
           else p.role
         end
    from profiles p
   where p.user_id = auth.uid() $$;
revoke execute on function auth_role() from public, anon;
grant execute on function auth_role() to authenticated, service_role;
