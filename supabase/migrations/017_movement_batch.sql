-- 017: the batch / production number on stock that leaves, so a receipt can
-- say which batch the customer got (and a recall can be traced to sales).
--
-- movements.batch  the batch number(s) of the expiry batch the stock left
--   from, copied when the movement is written. Filled by triggers, so
--   stock_move, write_off_expiry and the rest stay as they are:
--
--   * lots_keep_batch   a batch that is emptied is deleted before its last
--                       movement is written; its number is kept for the rest
--                       of the transaction (a transaction-local setting).
--   * movements_batch   an "out" movement with a date takes the number of its
--                       batch (or the one just emptied). A void putting stock
--                       back ("in" with a sale) takes the number the stock
--                       left with and puts it back on the batch.
--   Stock coming in is not marked: its number is set right after, by
--   set_lot_batch (016).

alter table public.movements add column batch text;

create function public.lot_batch_key(p_item uuid, p_expiry date)
returns text language sql immutable set search_path = public as $$
  select 'rapide.b' || replace(p_item::text, '-', '') || to_char(p_expiry, 'YYYYMMDD')
$$;

create function public.lots_keep_batch()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.batch is not null then
    perform set_config(public.lot_batch_key(old.item_id, old.expiry), old.batch, true);
  end if;
  return old;
end $$;

create trigger lots_keep_batch after delete on public.lots
  for each row execute function public.lots_keep_batch();

create function public.movements_batch()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.batch is not null or new.expiry is null or new.item_id is null then return new; end if;
  if new.type = 'out' then
    select batch into new.batch from lots where item_id = new.item_id and expiry = new.expiry;
    if new.batch is null then
      new.batch := nullif(current_setting(public.lot_batch_key(new.item_id, new.expiry), true), '');
    end if;
  elsif new.sale_id is not null then
    -- a void: the stock goes back with the number it left with
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

create trigger movements_batch before insert on public.movements
  for each row execute function public.movements_batch();
