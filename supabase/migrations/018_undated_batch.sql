-- 018: batch / production numbers for stock without an expiry date.
--
-- Stock with no date has no row in lots: it is the product's quantity minus
-- its dated batches. Its batch numbers are kept on the product instead:
--
-- items.batch  the batch number(s) of the product's undated stock ("A1, B2").
--   Written only by the functions below (clients have no column grant).
--
-- set_lot_batch(item, null, number, add) now sets items.batch (016 ignored a
--   missing date).
-- movements_batch (017) now also:
--   * stock leaving with no date takes the product's undated number(s);
--   * undated stock arriving when there was none left clears the old numbers
--     first (they belonged to stock that is gone);
--   * a void putting undated stock back puts its number back.

alter table public.items add column batch text check (char_length(batch) <= 120);

create or replace function public.set_lot_batch(p_item uuid, p_expiry date, p_batch text, p_add boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  select shop_id into v_shop from items where id = p_item;
  if not found or not public.can_write(v_shop) then raise exception 'item not found or shop is read-only'; end if;
  if p_expiry is null then
    update items
       set batch = case when p_add then public.lot_batch_add(batch, p_batch) else nullif(left(btrim(coalesce(p_batch, '')), 120), '') end
     where id = p_item;
    return;
  end if;
  update lots
     set batch = case when p_add then public.lot_batch_add(batch, p_batch) else nullif(left(btrim(coalesce(p_batch, '')), 120), '') end
   where item_id = p_item and expiry = p_expiry;
end $$;

create or replace function public.movements_batch()
returns trigger language plpgsql set search_path = public as $$
declare v_before numeric;
begin
  if new.batch is not null or new.item_id is null then return new; end if;

  -- ---------- undated stock: its numbers are on the product ----------
  if new.expiry is null then
    if new.type = 'out' then
      select batch into new.batch from items where id = new.item_id;
    elsif new.sale_id is null then
      -- stock_move has already added this delivery to items.qty
      select i.qty - new.qty - coalesce((select sum(l.qty) from lots l where l.item_id = i.id), 0)
        into v_before from items i where i.id = new.item_id;
      if v_before <= 0 then update items set batch = null where id = new.item_id and batch is not null; end if;
    else
      -- a void: the stock goes back with the number it left with
      select batch into new.batch from movements
       where sale_id = new.sale_id and item_id = new.item_id and expiry is null
         and type = 'out' and batch is not null
       order by created_at desc limit 1;
      if new.batch is not null then
        update items set batch = public.lot_batch_add(batch, new.batch) where id = new.item_id;
      end if;
    end if;
    return new;
  end if;

  -- ---------- dated stock (017) ----------
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
