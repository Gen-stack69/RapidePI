-- 020: a no-date delivery whose batch no. is one the product already has
-- joins that batch instead of starting another one.
--
-- 019 gave every no-date delivery its own batch. Scanning 5 cans of one
-- batch one at a time (+1 each) then made 5 batches "TH123 x1" instead of
-- one "TH123 x5". The same happened when a void put stock back while some
-- of that batch was still on the shelf.
--
-- set_lot_batch(item, null, number): when this delivery has no batch of its
--   own yet and the product has a no-date batch with exactly that number
--   (any case), the delivery's units are added to it. The delivery's
--   movement then carries the number, so a resend does not add them twice.
-- movements_batch (void): stock put back joins a no-date batch with the
--   same number.
-- Batches already split this way are merged here, into the oldest one.

-- ---------- merge what 019 split ----------
with g as (
  select id, first_value(id) over w keep_id, sum(qty) over (partition by item_id, lower(batch)) total
    from public.lots
   where expiry is null
  window w as (partition by item_id, lower(batch) order by created_at, id)
)
update public.lots l set qty = g.total from g where l.id = g.id and g.id = g.keep_id and g.total <> l.qty;

with g as (
  select id, first_value(id) over (partition by item_id, lower(batch) order by created_at, id) keep_id
    from public.lots
   where expiry is null
)
delete from public.lots l using g where l.id = g.id and g.id <> g.keep_id;

-- ---------- set_lot_batch (019) ----------
create or replace function public.set_lot_batch(p_item uuid, p_expiry date, p_batch text, p_add boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_shop uuid;
  v_b    text := nullif(left(btrim(coalesce(p_batch, '')), 120), '');
  v_m    movements%rowtype;
  v_lot  uuid;
  v_free numeric;
  v_n    numeric;
begin
  select shop_id into v_shop from items where id = p_item for update;
  if not found or not public.can_write(v_shop) then raise exception 'item not found or shop is read-only'; end if;
  if p_expiry is not null then
    update lots
       set batch = case when p_add then public.lot_batch_add(batch, v_b) else v_b end
     where item_id = p_item and expiry = p_expiry;
    return;
  end if;
  -- No date: the product's latest delivery without one gets its batch.
  if v_b is null then return; end if;
  select * into v_m from movements
   where item_id = p_item and type = 'in' and expiry is null and sale_id is null and note <> 'void'
   order by created_at desc, id desc limit 1;
  if not found then return; end if;
  select id into v_lot from lots where move_id = v_m.id;
  if found then
    update lots set batch = case when p_add then public.lot_batch_add(batch, v_b) else v_b end where id = v_lot;
    update movements set batch = (select batch from lots where id = v_lot) where id = v_m.id;
    return;
  end if;
  -- already joined to a batch of the same number (sent twice)
  if v_m.batch is not null then return; end if;
  select i.qty - coalesce((select sum(l.qty) from lots l where l.item_id = i.id), 0) into v_free
    from items i where i.id = p_item;
  v_n := least(v_m.qty, v_free);
  if v_n <= 0 then return; end if;
  select id into v_lot from lots
   where item_id = p_item and expiry is null and lower(batch) = lower(v_b)
   order by created_at, id limit 1 for update;
  if found then
    update lots set qty = qty + v_n where id = v_lot;
  else
    insert into lots (shop_id, item_id, expiry, qty, batch, move_id)
    values (v_shop, p_item, null, v_n, v_b, v_m.id) returning id into v_lot;
  end if;
  update movements set batch = (select batch from lots where id = v_lot) where id = v_m.id;
end $$;

-- ---------- movements_batch (019) ----------
create or replace function public.movements_batch()
returns trigger language plpgsql set search_path = public as $$
declare r record; v_lot uuid;
begin
  if new.item_id is null then return new; end if;

  -- ---------- no date ----------
  if new.expiry is null then
    -- a void: the no-date batches come back as they left, into a batch with
    -- the same number when one is still on the shelf
    if new.type = 'in' and new.sale_id is not null and new.batch is null then
      for r in select batch, sum(qty) q from movements
               where sale_id = new.sale_id and item_id = new.item_id and expiry is null
                 and type = 'out' and batch is not null
               group by batch loop
        select id into v_lot from lots
         where item_id = new.item_id and expiry is null and lower(batch) = lower(r.batch)
         order by created_at, id limit 1 for update;
        if found then update lots set qty = qty + r.q where id = v_lot;
        else insert into lots (shop_id, item_id, expiry, qty, batch) values (new.shop_id, new.item_id, null, r.q, r.batch);
        end if;
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
