-- 023: what each plan includes, besides tills (004/011).
--
--                 products  staff (managers + cashiers)  product photos
--   small           2,000     3                             500
--   mini (Minimart) 10,000   10                           3,000
--   trial           2,000     3                             500   (a new shop's defaults)
--
-- At the limit only adding more stops: a new product, a new person joining,
-- a photo on one more product. Selling, stock, edits, reports and backups go
-- on, and nothing is ever deleted. Approving a payment (approve_payment) gives
-- the shop its plan's numbers, as it already did for tills. Rapide's own SQL
-- (no signed-in user) is not limited.

alter table public.plans
  add column max_items  integer not null default 2000 check (max_items  > 0),
  add column max_staff  integer not null default 3    check (max_staff  >= 0),
  add column max_photos integer not null default 500  check (max_photos >= 0);
update public.plans set max_items = 2000,  max_staff = 3,  max_photos = 500  where code = 'small';
update public.plans set max_items = 10000, max_staff = 10, max_photos = 3000 where code = 'mini';

alter table public.shops
  add column max_items  integer not null default 2000 check (max_items  > 0),
  add column max_staff  integer not null default 3    check (max_staff  >= 0),
  add column max_photos integer not null default 500  check (max_photos >= 0);
-- Shops already on a paid plan get its numbers.
update public.shops s
   set max_items = p.max_items, max_staff = p.max_staff, max_photos = p.max_photos
  from (select distinct on (shop_id) shop_id, plan from public.payments
         where status = 'approved' order by shop_id, decided_at desc) last
  join public.plans p on p.code = last.plan
 where s.id = last.shop_id;

-- ---------- the checks: once per statement, so an import of 2,000 rows counts once ----------
create function public.plan_limit_items()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if auth.uid() is null then return null; end if;
  for r in
    select s.id, s.max_items, (select count(*) from items i where i.shop_id = s.id) n
      from shops s where s.id in (select distinct shop_id from new_rows)
  loop
    if r.n > r.max_items then raise exception 'plan limit: products %', r.max_items using errcode = 'P0001'; end if;
  end loop;
  return null;
end $$;
create trigger items_plan_limit after insert on public.items
  referencing new table as new_rows for each statement execute function public.plan_limit_items();

create function public.plan_limit_photos()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if auth.uid() is null then return null; end if;
  -- Only when a product gained a photo (every sale updates items too).
  if not exists (select 1 from new_rows n join old_rows o using (id) where n.photo is not null and o.photo is null) then
    return null;
  end if;
  for r in
    select s.id, s.max_photos, (select count(*) from items i where i.shop_id = s.id and i.photo is not null) n
      from shops s where s.id in (select distinct shop_id from new_rows)
  loop
    if r.n > r.max_photos then raise exception 'plan limit: photos %', r.max_photos using errcode = 'P0001'; end if;
  end loop;
  return null;
end $$;
create trigger items_plan_limit_photos after update on public.items
  referencing new table as new_rows old table as old_rows for each statement execute function public.plan_limit_photos();

create function public.plan_limit_staff()
returns trigger language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if auth.uid() is null then return null; end if;
  for r in
    select s.id, s.max_staff, (select count(*) from members m where m.shop_id = s.id and m.role <> 'owner') n
      from shops s where s.id in (select distinct shop_id from new_rows where role <> 'owner')
  loop
    if r.n > r.max_staff then raise exception 'plan limit: staff %', r.max_staff using errcode = 'P0001'; end if;
  end loop;
  return null;
end $$;
create trigger members_plan_limit after insert on public.members
  referencing new table as new_rows for each statement execute function public.plan_limit_staff();

revoke execute on function public.plan_limit_items(), public.plan_limit_photos(), public.plan_limit_staff()
  from public, anon, authenticated;

-- ---------- approving a payment gives the plan's numbers (011, unchanged otherwise) ----------
create or replace function public.approve_payment(p_id uuid, p_note text default null)
returns public.payments language plpgsql security definer set search_path = public as $$
declare
  v_row  payments;
  v_shop shops;
  v_plan plans;
  v_from timestamptz;
  v_to   timestamptz;
begin
  if not public.is_platform_admin() then raise exception 'only a Rapide admin can approve payments'; end if;
  select * into v_row from payments where id = p_id for update;
  if not found then raise exception 'payment not found'; end if;
  if v_row.status <> 'pending' then raise exception 'payment already decided'; end if;
  select * into v_shop from shops where id = v_row.shop_id for update;
  select * into v_plan from plans where code = v_row.plan;

  v_from := greatest(now(), v_shop.plan_until);
  v_to   := v_from + make_interval(months => v_row.months);

  update shops
     set plan = 'paid', plan_until = v_to,
         max_tills = v_plan.max_tills, max_items = v_plan.max_items,
         max_staff = v_plan.max_staff, max_photos = v_plan.max_photos
   where id = v_row.shop_id;
  update payments
     set status = 'approved', decided_by = auth.uid(), decided_at = now(),
         note = nullif(trim(p_note), ''), period_from = v_from, period_to = v_to
   where id = p_id
  returning * into v_row;
  return v_row;
end $$;

-- ---------- devices see their shop's numbers (022, with the limits added) ----------
create or replace function public.sync_changes(p_shop uuid, p_since timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from   timestamptz := p_since - interval '2 minutes';
  v_window timestamptz := now() - interval '30 days';
  v_n      bigint;
begin
  if not public.is_member(p_shop) then raise exception 'not a member of this shop'; end if;
  if p_since is null then return jsonb_build_object('now', now()); end if;
  select (select count(*) from items where shop_id = p_shop and updated_at > v_from)
       + (select count(*) from lots where shop_id = p_shop and updated_at > v_from)
       + (select count(*) from movements where shop_id = p_shop and updated_at > v_from)
       + (select count(*) from sale_lines where shop_id = p_shop and updated_at > v_from)
    into v_n;
  if v_n > 5000 then return jsonb_build_object('now', now(), 'too_many', true); end if;
  return jsonb_build_object(
    'now', now(),
    'items',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from items x where shop_id = p_shop and updated_at > v_from),
    'orders',        (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from orders x where shop_id = p_shop and updated_at > v_from),
    'movements',     (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from movements x
                       where shop_id = p_shop and updated_at > v_from and created_at >= v_window),
    'settings',      (select to_jsonb(x) from settings x where shop_id = p_shop and updated_at > v_from),
    'lots',          (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from lots x where shop_id = p_shop and updated_at > v_from),
    'sales',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sales x
                       where shop_id = p_shop and updated_at > v_from and created_at >= v_window),
    'sale_lines',    (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sale_lines x
                       where shop_id = p_shop and updated_at > v_from and created_at >= v_window),
    'tills',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from tills x where shop_id = p_shop and updated_at > v_from),
    'packs',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from packs x where shop_id = p_shop and updated_at > v_from),
    'pack_receipts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from pack_receipts x
                       where shop_id = p_shop and updated_at > v_from and (size is null or created_at >= v_window)),
    'customers',     (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from customers x where shop_id = p_shop and updated_at > v_from),
    'shop',          (select jsonb_build_object('id', id, 'name', name, 'plan', plan, 'plan_until', plan_until,
                                                'max_tills', max_tills, 'max_items', max_items,
                                                'max_staff', max_staff, 'max_photos', max_photos)
                        from shops where id = p_shop),
    'deleted',       (select coalesce(jsonb_agg(jsonb_build_object('t', tbl, 'id', row_id)), '[]')
                        from deleted_rows where shop_id = p_shop and deleted_at > v_from));
end $$;
