-- supabase/migrations/0006_signup.sql
-- Every new auth user gets a 'patient' profile. The role is NEVER read from user metadata
-- (raw_user_meta_data is client-controlled at signup). Staff are promoted by the owner via SQL.
-- display_name is trimmed (spaces, tabs, newlines) and capped at 100 characters; it falls back to the
-- email local part, then to 'Patient'.
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public, pg_temp as
$$ begin
  insert into profiles(user_id, role, display_name)
  values (new.id, 'patient',
          coalesce(nullif(btrim(left(btrim(new.raw_user_meta_data->>'name', E' \t\r\n'), 100), E' \t\r\n'), ''),
                   nullif(btrim(left(split_part(coalesce(new.email, ''), '@', 1), 100), E' \t\r\n'), ''),
                   'Patient'));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- trigger-only function: nobody calls it directly (R4)
revoke execute on function handle_new_user() from public, anon, authenticated, service_role;
