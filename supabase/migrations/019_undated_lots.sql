-- 019: every delivery without an expiry date that has a batch no. becomes
-- its own batch, with its own quantity (018 kept one combined number on the
-- product, so two deliveries couldn't be told apart).
--
-- lots with expiry = null  a no-date batch. It always has a batch no.; stock
--   with neither a date nor a number stays "free" (product qty minus lots).
--   move_id: the delivery (movement) it came in with.
-- stock_move takes stock in this order: the expiring-price batch, in-date
--   batches soonest first, free stock, no-date batches oldest first, expired.
-- set_lot_batch(item, null, number) gives the product's latest no-date
--   delivery its own batch (or adds the number to the one it already has).
-- set_undated_lot_batch(lot, number) corrects one; an empty number puts the
--   stock back into free stock.
-- A void puts no-date batches back as they left. items.batch (018) is moved
-- into batches here and no longer used.

alter table public.lots alter column expiry drop not null;
alter table public.lots add constraint lots_dated_or_numbered check (expiry is not null or batch is not null);
alter table public.lots add column move_id uuid references public.movements on delete set null;
create index lots_move_idx on public.lots (move_id) where move_id is not null;

-- ---------- 018's numbers become batches ----------
insert into public.lots (shop_id, item_id, expiry, qty, batch)
select i.shop_id, i.id, null, i.qty - coalesce((select sum(l.qty) from public.lots l where l.item_id = i.id), 0), i.batch
  from public.items i
 where i.batch is not null
   and i.qty - coalesce((select sum(l.qty) from public.lots l where l.item_id = i.id), 0) > 0;
update public.items set batch = null where batch is not null;

-- ---------- stock_move (006) with no-date batches ----------
create or replace function public.stock_move(
  p_item uuid, p_delta numeric, p_note text, p_expiry date, p_sale uuid,
  p_short boolean default false, p_at timestamptz default null, p_first date default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_item    items%rowtype;
  v_qty     numeric;
  v_at      timestamptz := coalesce(p_at, now());
  v_today   date := (now() at time zone 'Asia/Vientiane')::date;
  v_left    numeric;
  v_free    numeric;
  v_take    numeric;
  v_lot     numeric;
  v_expired boolean;
  r         record;
begin
  if p_delta is null or p_delta = 0 then raise exception 'quantity must not be zero'; end if;
  select * into v_item from items where id = p_item for update;
  if not found or not public.can_write(v_item.shop_id) then
    raise exception 'item not found or shop is read-only';
  end if;
  v_qty := v_item.qty + p_delta;
  if v_qty < 0 and p_delta < 0 and not p_short then
    raise exception 'not enough stock: % has %', v_item.sku, v_item.qty using errcode = 'P0001';
  end if;
  update items set qty = v_qty, updated_at = now() where id = p_item;

  if p_delta > 0 then
    v_lot := least(p_delta, greatest(v_qty, 0));
    if p_expiry is not null and v_lot > 0 then
      insert into lots (shop_id, item_id, expiry, qty) values (v_item.shop_id, p_item, p_expiry, v_lot)
      on conflict (item_id, expiry) do update set qty = lots.qty + excluded.qty;
    end if;
    insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
    values (v_item.shop_id, p_item, v_item.sku, 'in', p_delta, coalesce(p_note, ''), p_expiry, p_sale, v_at);
  else
    v_left := -p_delta;
    select greatest(v_item.qty - coalesce(sum(qty), 0), 0) into v_free from lots where item_id = p_item;
    if p_first is not null then
      for r in select id, expiry, qty from lots where item_id = p_item and expiry = p_first for update loop
        v_take := least(r.qty, v_left);
        if v_take = r.qty then delete from lots where id = r.id;
        else update lots set qty = qty - v_take where id = r.id; end if;
        insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
        values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), r.expiry, p_sale, v_at);
        v_left := v_left - v_take;
      end loop;
    end if;
    foreach v_expired in array array[false, true] loop
      for r in select id, expiry, qty from lots
               where item_id = p_item and expiry is not null and (expiry < v_today) = v_expired
               order by expiry for update loop
        exit when v_left = 0;
        v_take := least(r.qty, v_left);
        if v_take = r.qty then delete from lots where id = r.id;
        else update lots set qty = qty - v_take where id = r.id; end if;
        insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
        values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), r.expiry, p_sale, v_at);
        v_left := v_left - v_take;
      end loop;
      if not v_expired then
        -- stock with no date and no number
        if v_left > 0 and v_free > 0 then
          v_take := least(v_free, v_left);
          insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
          values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), null, p_sale, v_at);
          v_left := v_left - v_take;
        end if;
        -- no-date batches, the oldest delivery first
        for r in select id, qty, batch from lots
                 where item_id = p_item and expiry is null
                 order by created_at, id for update loop
          exit when v_left = 0;
          v_take := least(r.qty, v_left);
          if v_take = r.qty then delete from lots where id = r.id;
          else update lots set qty = qty - v_take where id = r.id; end if;
          insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at, batch)
          values (v_item.shop_id, p_item, v_item.sku, 'out', v_take, coalesce(p_note, ''), null, p_sale, v_at, r.batch);
          v_left := v_left - v_take;
        end loop;
      end if;
    end loop;
    if v_left > 0 then
      insert into movements (shop_id, item_id, sku, type, qty, note, expiry, sale_id, created_at)
      values (v_item.shop_id, p_item, v_item.sku, 'out', v_left, coalesce(p_note, ''), null, p_sale, v_at);
    end if;
  end if;

  perform public.auto_reorder(p_item);
  return v_qty;
end $$;

-- ---------- batch numbers ----------
create or replace function public.set_lot_batch(p_item uuid, p_expiry date, p_batch text, p_add boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_b    text := nullif(left(btrim(coalesce(p_batch, '')), 120), '');
  v_m    movements%rowtype;
  v_lot  uuid;
  v_free numeric;
begin
  select shop_id into v_shop from items where id = p_item for update;
  if not found or not public.can_write(v_shop) then raise exception 'item not found or shop is read-only'; end if;
  if p_expiry is not null then
    update lots
       set batch = case when p_add then public.lot_batch_add(batch, v_b) else v_b end
     where item_id = p_item and expiry = p_expiry;
    return;
  end if;
  -- No date: the product's latest delivery without one gets its own batch.
  if v_b is null then return; end if;
  select * into v_m from movements
   where item_id = p_item and type = 'in' and expiry is null and sale_id is null and note <> 'void'
   order by created_at desc, id desc limit 1;
  if not found then return; end if;
  select id into v_lot from lots where move_id = v_m.id;
  if found then
    update lots set batch = case when p_add then public.lot_batch_add(batch, v_b) else v_b end where id = v_lot;
  else
    select i.qty - coalesce((select sum(l.qty) from lots l where l.item_id = i.id), 0) into v_free
      from items i where i.id = p_item;
    if least(v_m.qty, v_free) <= 0 then return; end if;
    insert into lots (shop_id, item_id, expiry, qty, batch, move_id)
    values (v_shop, p_item, null, least(v_m.qty, v_free), v_b, v_m.id);
  end if;
  update movements set batch = (select batch from lots where move_id = v_m.id) where id = v_m.id;
end $$;

create function public.set_undated_lot_batch(p_lot uuid, p_batch text)
returns void language plpgsql security definer set search_path = public as $$
declare v_l lots%rowtype; v_b text := nullif(left(btrim(coalesce(p_batch, '')), 120), '');
begin
  select * into v_l from lots where id = p_lot for update;
  if not found or v_l.expiry is not null or not public.can_write(v_l.shop_id) then
    raise exception 'lot not found or shop is read-only';
  end if;
  -- no number left: the stock goes back to stock with neither date nor number
  if v_b is null then delete from lots where id = p_lot;
  else update lots set batch = v_b where id = p_lot; end if;
end $$;

revoke execute on function public.set_undated_lot_batch(uuid, text) from public, anon;
grant execute on function public.set_undated_lot_batch(uuid, text) to authenticated;

-- ---------- triggers ----------
create or replace function public.lots_keep_batch()
returns trigger language plpgsql set search_path = public as $$
begin
  -- dated batches only: a no-date batch writes its number on its movements itself
  if old.batch is not null and old.expiry is not null then
    perform set_config(public.lot_batch_key(old.item_id, old.expiry), old.batch, true);
  end if;
  return old;
end $$;

create or replace function public.movements_batch()
returns trigger language plpgsql set search_path = public as $$
declare r record;
begin
  if new.item_id is null then return new; end if;

  -- ---------- no date ----------
  if new.expiry is null then
    -- a void: the no-date batches come back as they left
    if new.type = 'in' and new.sale_id is not null and new.batch is null then
      for r in select batch, sum(qty) q from movements
               where sale_id = new.sale_id and item_id = new.item_id and expiry is null
                 and type = 'out' and batch is not null
               group by batch loop
        insert into lots (shop_id, item_id, expiry, qty, batch) values (new.shop_id, new.item_id, null, r.q, r.batch);
      end loop;
    end if;
    return new;
  end if;

  -- ---------- dated (017) ----------
  if new.batch is not null then return new; end if;
  if new.type = 'out' then
    select batch into new.batch from lots where item_id = new.item_id and expiry = new.expiry;
    if new.batch is null then
      new.batch := nullif(current_setting(public.lot_batch_key(new.item_id, new.expiry), true), '');
    end if;
  elsif new.sale_id is not null then
    select batch into new.batch from movements
     where sale_id = new.sale_id and item_id = new.item_id and expiry = new.expiry
       and type = 'out' and batch is not null
     order by created_at desc limit 1;
    if new.batch is not null then
      update lots set batch = public.lot_batch_add(batch, new.batch)
       where item_id = new.item_id and expiry = new.expiry;
    end if;
  end if;
  return new;
end $$;
