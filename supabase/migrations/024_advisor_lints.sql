-- 024: Supabase Security Advisor warnings (splinter).
--
-- 1. "Function Search Path Mutable": device_time (003) and proof_shop (012)
--    were the only functions without a fixed search_path.
-- 2. "Public Can Execute SECURITY DEFINER Function": is_member, is_owner and
--    can_write could be called by signed-out visitors (anon). They answered
--    false for them, but there is no reason to expose them. The table policies
--    of 001-011 that call them applied to every role ("public"); they now apply
--    to signed-in users only (signed-out visitors have no table access anyway).
--
-- Left as they are, on purpose:
--  - "Signed-In Users Can Execute SECURITY DEFINER Function": these functions
--    are the app's API (create_sale, adjust_stock, ...); each one checks the
--    caller's shop and role itself.
--  - "RLS Enabled No Policy" (applied_ops, deleted_rows, invites,
--    platform_admins): read and written only through those functions.

alter function public.device_time(timestamptz) set search_path = public;
alter function public.proof_shop(text) set search_path = public;

do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies
            where schemaname = 'public' and roles = '{public}' loop
    execute format('alter policy %I on %I.%I to authenticated', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

revoke execute on function public.is_member(uuid), public.is_owner(uuid), public.can_write(uuid) from public, anon;
grant execute on function public.is_member(uuid), public.is_owner(uuid), public.can_write(uuid) to authenticated;
