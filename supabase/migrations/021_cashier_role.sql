-- 021: a Cashier role, for the cashier site (cashier.rapidewms.workers.dev).
--
-- A shop now has three kinds of member:
--   owner    everything (unchanged)
--   staff    shown as "Manager": sells, receives and ships stock, edits
--            products, as staff could before (unchanged)
--   cashier  sells at the till (sales, customers, its own till) and can look
--            at products and stock, but changes no stock and no product:
--            no receiving, shipping, counting, write-offs, batch or expiry
--            changes, product edits, packs or orders.
--
-- The cashier's limits are checked here, in the database, not only in the
-- app: a cashier who opens the manager site, an old app version or the API
-- directly is refused the same way. They are triggers on the tables the stock
-- functions write, so every function (today's and later ones) is covered
-- without rewriting them:
--   movements  a move that isn't part of a sale (sale_id null)
--   items      a new or deleted product; any change except the qty and
--              updated_at a sale makes
--   lots       a new batch; a change of date, batch no. or price
--   orders     any change, except the automatic reorder a sale can make
--   packs, pack_receipts  any change
-- Sales, customers and tills are not limited (the till).
--
-- The owner picks the role on the invite code, and can switch a member
-- between Manager and Cashier later (set_member_role).

-- ---------- the role ----------
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check check (role in ('owner', 'staff', 'cashier'));

alter table public.invites add column role text not null default 'staff' check (role in ('staff', 'cashier'));

create function public.is_cashier(p_shop uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where shop_id = p_shop and user_id = auth.uid() and role = 'cashier');
$$;

-- ---------- the guards ----------
create function public.cashier_guard()
returns trigger language plpgsql security definer set search_path = public as $$
-- Separate IF branches on purpose: an expression naming new.sale_id would not
-- even plan on a table without that column.
declare
  v_shop uuid;
  v_stop boolean := true; -- packs, pack_receipts: any change
begin
  if tg_op = 'DELETE' then v_shop := old.shop_id; else v_shop := new.shop_id; end if;
  if auth.uid() is not null and public.is_cashier(v_shop) then
    if tg_table_name = 'movements' then
      v_stop := new.sale_id is null;
    elsif tg_table_name = 'items' then
      if tg_op = 'UPDATE' then
        v_stop := (to_jsonb(new) - 'qty' - 'updated_at') is distinct from (to_jsonb(old) - 'qty' - 'updated_at');
      end if;
    elsif tg_table_name = 'lots' then
      if tg_op = 'UPDATE' then
        v_stop := new.expiry is distinct from old.expiry
               or new.batch is distinct from old.batch
               or new.price is distinct from old.price;
      end if;
    elsif tg_table_name = 'orders' then
      if tg_op = 'INSERT' then v_stop := not coalesce(new.auto, false); end if;
    end if;
    if v_stop then raise exception 'cashiers can only sell' using errcode = '42501'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger movements_cashier_guard before insert on public.movements
  for each row execute function public.cashier_guard();
create trigger items_cashier_guard before insert or update or delete on public.items
  for each row execute function public.cashier_guard();
create trigger lots_cashier_guard before insert or update on public.lots
  for each row execute function public.cashier_guard();
create trigger orders_cashier_guard before insert or update or delete on public.orders
  for each row execute function public.cashier_guard();
create trigger packs_cashier_guard before insert or update or delete on public.packs
  for each row execute function public.cashier_guard();
create trigger pack_receipts_cashier_guard before insert or update or delete on public.pack_receipts
  for each row execute function public.cashier_guard();

revoke execute on function public.cashier_guard() from public, anon, authenticated;
revoke execute on function public.is_cashier(uuid) from public, anon;
grant execute on function public.is_cashier(uuid) to authenticated;

-- Product photos: a cashier sees them but doesn't change them.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and to_regclass('storage.buckets') is not null then
    execute $p$drop policy if exists product_photos_insert on storage.objects$p$;
    execute $p$drop policy if exists product_photos_update on storage.objects$p$;
    execute $p$drop policy if exists product_photos_delete on storage.objects$p$;
    execute $p$create policy product_photos_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'product-photos' and public.can_write(public.proof_shop(name))
                  and not public.is_cashier(public.proof_shop(name)))$p$;
    execute $p$create policy product_photos_update on storage.objects for update to authenticated
      using (bucket_id = 'product-photos' and public.can_write(public.proof_shop(name))
             and not public.is_cashier(public.proof_shop(name)))
      with check (bucket_id = 'product-photos' and public.can_write(public.proof_shop(name))
                  and not public.is_cashier(public.proof_shop(name)))$p$;
    execute $p$create policy product_photos_delete on storage.objects for delete to authenticated
      using (bucket_id = 'product-photos' and public.can_write(public.proof_shop(name))
             and not public.is_cashier(public.proof_shop(name)))$p$;
  end if;
end $$;

-- ---------- invites carry the role ----------
drop function public.create_invite(uuid);
create function public.create_invite(p_shop uuid, p_role text default 'staff')
returns text language plpgsql security definer set search_path = public as $$
declare
  v_abc  constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_b    bytea;
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can invite staff'; end if;
  if coalesce(p_role, '') not in ('staff', 'cashier') then raise exception 'role must be staff or cashier'; end if;
  if (select count(*) from invites
      where shop_id = p_shop and used_at is null and expires_at > now()) >= 10 then
    raise exception 'too many open invites';
  end if;
  loop
    v_b := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
    v_code := '';
    for i in 0..7 loop
      v_code := v_code || substr(v_abc, 1 + get_byte(v_b, case when i < 6 then i else i + 10 end) % 31, 1);
    end loop;
    exit when not exists (select 1 from invites where code = v_code);
  end loop;
  insert into invites (code, shop_id, created_by, role) values (v_code, p_shop, auth.uid(), p_role);
  return v_code;
end $$;

create or replace function public.join_shop(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_inv invites%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into v_inv from invites
  where code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'))
    and used_at is null and expires_at > now()
  for update;
  if not found then raise exception 'invite code not valid'; end if;
  if exists (select 1 from members where shop_id = v_inv.shop_id and user_id = auth.uid()) then
    raise exception 'already a member of this shop';
  end if;
  insert into members (shop_id, user_id, role) values (v_inv.shop_id, auth.uid(), v_inv.role);
  update invites set used_by = auth.uid(), used_at = now() where code = v_inv.code;
  return v_inv.shop_id;
end $$;

create or replace function public.shop_people(p_shop uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can see staff'; end if;
  return jsonb_build_object(
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role,
                                          'created_at', m.created_at) order by m.role, m.created_at)
      from members m join auth.users u on u.id = m.user_id where m.shop_id = p_shop), '[]'::jsonb),
    'invites', coalesce((
      select jsonb_agg(jsonb_build_object('code', i.code, 'expires_at', i.expires_at, 'role', i.role) order by i.created_at)
      from invites i where i.shop_id = p_shop and i.used_at is null and i.expires_at > now()), '[]'::jsonb));
end $$;

create or replace function public.remove_member(p_shop uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can remove staff'; end if;
  delete from members where shop_id = p_shop and user_id = p_user and role in ('staff', 'cashier');
  if not found then raise exception 'not a staff member'; end if;
end $$;

-- Switch someone between Manager (staff) and Cashier. Never the owner.
create function public.set_member_role(p_shop uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can change roles'; end if;
  if coalesce(p_role, '') not in ('staff', 'cashier') then raise exception 'role must be staff or cashier'; end if;
  update members set role = p_role where shop_id = p_shop and user_id = p_user and role in ('staff', 'cashier');
  if not found then raise exception 'not a staff member'; end if;
end $$;

revoke execute on function public.create_invite(uuid, text), public.set_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.create_invite(uuid, text), public.set_member_role(uuid, uuid, text) to authenticated;
