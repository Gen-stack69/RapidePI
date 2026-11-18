-- 012: a screenshot of the transfer comes with "I've paid".
--
-- * payments.proof_path  where the shop's screenshot of the successful transfer
--                        is stored: payment-proofs/<shop id>/<payment id>.jpg.
-- * claim_payment(id, proof)  now takes that path and refuses one that isn't
--                        in the paying shop's own folder.
-- * Storage bucket payment-proofs is private. The shop's owner uploads into
--   their own shop's folder; the shop's members and Rapide admins can read it.
--   Nobody else, and no public links.
-- * admin_payments() also returns proof_path, so the admin can open it.
--
-- The storage part only runs where Supabase Storage exists (not in the tests).

alter table public.payments
  add column proof_path text check (proof_path is null or proof_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$');

drop function public.claim_payment(uuid);
create or replace function public.claim_payment(p_id uuid, p_proof text default null)
returns public.payments language plpgsql security definer set search_path = public as $$
declare v_row payments;
begin
  select * into v_row from payments where id = p_id for update;
  if not found or not public.is_owner(v_row.shop_id) then raise exception 'payment not found'; end if;
  if v_row.status <> 'pending' then raise exception 'payment already decided'; end if;
  if p_proof is not null and p_proof <> v_row.shop_id || '/' || v_row.id || '.jpg' then
    raise exception 'payment proof must be the payment''s own file';
  end if;
  update payments
     set claimed_at = coalesce(claimed_at, now()), proof_path = coalesce(p_proof, proof_path)
   where id = p_id
  returning * into v_row;
  return v_row;
end $$;

drop function public.admin_payments(integer);
create or replace function public.admin_payments(p_limit integer default 200)
returns table (
  id uuid, shop_id uuid, shop_name text, owner_email text, plan text, months integer,
  amount_kip bigint, reference text, status text, created_at timestamptz,
  claimed_at timestamptz, decided_at timestamptz, note text, plan_until timestamptz, proof_path text
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'only a Rapide admin can see all payments'; end if;
  return query
    select p.id, p.shop_id, s.name, (
             select u.email::text from members m join auth.users u on u.id = m.user_id
              where m.shop_id = p.shop_id and m.role = 'owner' order by m.user_id limit 1),
           p.plan, p.months, p.amount_kip, p.reference, p.status, p.created_at,
           p.claimed_at, p.decided_at, p.note, s.plan_until, p.proof_path
      from payments p join shops s on s.id = p.shop_id
     order by (p.status = 'pending') desc, (p.claimed_at is null), coalesce(p.claimed_at, p.created_at)
     limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $$;

revoke execute on function public.claim_payment(uuid, text), public.admin_payments(integer) from public, anon;
grant execute on function public.claim_payment(uuid, text), public.admin_payments(integer) to authenticated;

-- ---------- the private bucket (Supabase only) ----------

-- The first part of the path is the shop's id, as text. A path that isn't a
-- uuid simply matches no shop.
create or replace function public.proof_shop(p_name text)
returns uuid language sql immutable as $$
  select case when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name, '/', 1)::uuid end;
$$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('payment-proofs', 'payment-proofs', false, 3145728, array['image/jpeg'])
    on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];

    execute $p$drop policy if exists payment_proofs_insert on storage.objects$p$;
    execute $p$drop policy if exists payment_proofs_update on storage.objects$p$;
    execute $p$drop policy if exists payment_proofs_select on storage.objects$p$;
    execute $p$create policy payment_proofs_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'payment-proofs' and public.is_owner(public.proof_shop(name)))$p$;
    execute $p$create policy payment_proofs_update on storage.objects for update to authenticated
      using (bucket_id = 'payment-proofs' and public.is_owner(public.proof_shop(name)))
      with check (bucket_id = 'payment-proofs' and public.is_owner(public.proof_shop(name)))$p$;
    execute $p$create policy payment_proofs_select on storage.objects for select to authenticated
      using (bucket_id = 'payment-proofs'
             and (public.is_member(public.proof_shop(name)) or public.is_platform_admin()))$p$;
  end if;
end $$;
