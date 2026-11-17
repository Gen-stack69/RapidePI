-- 010: receiving boxes and cartons without counting them twice.
--
-- Deliveries in Laos come in cartons, often with no barcode of their own or
-- with the single can's barcode printed on the box. Before this, a box with an
-- unknown barcode was usually added as a new product, so the shop ended up
-- with "Pepsi" and "Pepsi carton" counted separately. Now:
--
-- * Stock is still counted in single units only. A box is a pack of its
--   product (006), never a product of its own.
-- * Staff can link a box to a product while receiving: name, barcode and how
--   many are inside. The price of a pack stays the owner's (as in 008): staff
--   add packs with no price, and a pack with a price is the owner's to change.
-- * "Count later". A pack may be saved before anyone knows how many are inside
--   (size null). Boxes received with it wait in pack_receipts and add nothing
--   to stock, so nothing is ever guessed and then counted again. When someone
--   opens a box and enters the count, set_pack_size moves every waiting box
--   into stock at once, at its expiry date.
-- * A pack with no count can't have a price, so it can't be sold by the box.
-- * Fixing a wrong count. set_pack_size can also fix boxes already received
--   at the old count, with one visible correction in the movements log.
-- * Every box received goes through receive_pack, which keeps a line per
--   delivery in pack_receipts (how many boxes, at what count), so a fix knows
--   how many boxes came in at the old count.

-- ---------- packs: count later ----------

alter table public.packs alter column size drop not null;
alter table public.packs add column sized_at timestamptz;
update public.packs set sized_at = created_at;
alter table public.packs add constraint packs_count_before_price check (size is not null or price = 0);

-- Staff may add a pack and change an unpriced one; the owner prices it.
drop policy packs_insert on public.packs;
drop policy packs_update on public.packs;
create policy packs_insert on public.packs for insert with check (
  public.can_write(shop_id)
  and exists (select 1 from public.items i where i.id = item_id and i.shop_id = packs.shop_id));
create policy packs_update on public.packs for update
  using (public.can_write(shop_id)) with check (public.can_write(shop_id));
-- The count changes only through set_pack_size, which also moves the stock.
revoke update (size) on public.packs from authenticated;

-- Same idea as items_price_guard (008). auth.uid() is null for the admin's own SQL.
create function public.packs_price_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_owner(new.shop_id) then return new; end if;
  if tg_op = 'INSERT' then
    if new.price <> 0 then raise exception 'only the owner can set prices'; end if;
  elsif old.price <> 0 or new.price <> old.price then
    raise exception 'only the owner can change a priced pack';
  end if;
  return new;
end $$;
create trigger packs_price_guard before insert or update on public.packs
  for each row execute function public.packs_price_guard();
revoke execute on function public.packs_price_guard() from public, anon, authenticated;

-- ---------- boxes received ----------

create table public.pack_receipts (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops on delete cascade,
  item_id    uuid not null references public.items on delete cascade,
  pack_id    uuid not null references public.packs on delete cascade,
  boxes      numeric not null check (boxes > 0 and abs(boxes) < 'Infinity'::numeric),
  size       numeric check (size > 1 and abs(size) < 'Infinity'::numeric), -- null: waiting to be counted
  expiry     date,
  created_at timestamptz not null default now(),
  counted_at timestamptz
);
create index pack_receipts_waiting_idx on public.pack_receipts (pack_id) where size is null;
create index pack_receipts_shop_idx on public.pack_receipts (shop_id, created_at);

alter table public.pack_receipts enable row level security;
create policy pack_receipts_select on public.pack_receipts for select using (public.is_member(shop_id));
revoke all on public.pack_receipts from anon, authenticated;
grant select on public.pack_receipts to authenticated;

-- Receive boxes of a pack. Counted: size x boxes go into stock now. Not
-- counted yet: the boxes wait. Queued like adjust_stock (003): a resent
-- p_client_id changes nothing, p_at is when it happened on the device.
create function public.receive_pack(
  p_pack uuid, p_boxes numeric, p_expiry date, p_client_id text,
  p_at timestamptz default null, p_offline boolean default false)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_pack packs%rowtype; v_t record;
begin
  -- Locked, so a count being entered on another phone can't miss these boxes.
  select * into v_pack from packs where id = p_pack for update;
  if not found or not public.can_write(v_pack.shop_id) then
    raise exception 'pack not found or shop is read-only';
  end if;
  if p_boxes is null or not (p_boxes > 0) or not (abs(p_boxes) < 'Infinity'::numeric) then
    raise exception 'quantity must be more than zero';
  end if;
  if not public.first_time(v_pack.shop_id, p_client_id, 'receive_pack') then
    return (select qty from items where id = v_pack.item_id);
  end if;
  select * into v_t from public.device_time(p_at);
  insert into pack_receipts (shop_id, item_id, pack_id, boxes, size, expiry, created_at, counted_at)
  values (v_pack.shop_id, v_pack.item_id, p_pack, p_boxes, v_pack.size, p_expiry, v_t.v_at,
          case when v_pack.size is not null then v_t.v_at end);
  if v_pack.size is null then return (select qty from items where id = v_pack.item_id); end if;
  return public.stock_move(v_pack.item_id, p_boxes * v_pack.size, 'box', p_expiry, null,
                           coalesce(p_offline, false), v_t.v_at);
end $$;

-- Enter (or correct) how many are in one box.
--   Boxes waiting to be counted go into stock: boxes x p_size each.
--   p_fix_boxes: boxes already received at the old count to correct, as one
--   movement of p_fix_boxes x (new - old). 0 leaves past deliveries alone.
create function public.set_pack_size(p_pack uuid, p_size numeric, p_fix_boxes numeric default 0)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_pack packs%rowtype; v_fix numeric := coalesce(p_fix_boxes, 0); r record;
begin
  select * into v_pack from packs where id = p_pack for update;
  if not found or not public.can_write(v_pack.shop_id) then
    raise exception 'pack not found or shop is read-only';
  end if;
  if v_pack.price <> 0 and not public.is_owner(v_pack.shop_id) then
    raise exception 'only the owner can change a priced pack';
  end if;
  if p_size is null or not (p_size > 1) or not (abs(p_size) < 'Infinity'::numeric) then
    raise exception 'a pack holds more than 1';
  end if;
  if not (v_fix >= 0) or not (abs(v_fix) < 'Infinity'::numeric) then
    raise exception 'boxes to fix must be 0 or more';
  end if;
  update packs set size = p_size,
                   sized_at = case when size is distinct from p_size then now() else sized_at end
  where id = p_pack;
  for r in select * from pack_receipts where pack_id = p_pack and size is null order by created_at for update loop
    perform public.stock_move(r.item_id, r.boxes * p_size, 'box counted', r.expiry, null, false, now());
    update pack_receipts set size = p_size, counted_at = now() where id = r.id;
  end loop;
  if v_pack.size is not null and v_pack.size <> p_size and v_fix > 0 then
    perform public.stock_move(v_pack.item_id, v_fix * (p_size - v_pack.size), 'box count fixed', null, null, false, now());
  end if;
  return (select qty from items where id = v_pack.item_id);
end $$;

-- ---------- grants ----------

revoke execute on function
  public.receive_pack(uuid, numeric, date, text, timestamptz, boolean),
  public.set_pack_size(uuid, numeric, numeric)
  from public, anon;
grant execute on function
  public.receive_pack(uuid, numeric, date, text, timestamptz, boolean),
  public.set_pack_size(uuid, numeric, numeric)
  to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.pack_receipts;
  end if;
end $$;
