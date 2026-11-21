-- 016: a batch / production number on each expiry batch.
--
-- lots.batch  the number printed on the goods (batch, lot or production no.),
--   so a new delivery of a product already in stock can be told apart from
--   the old one. Stock is still kept per expiry date: when two deliveries
--   share a date, the batch keeps both numbers ("A123, B456").
--
-- set_lot_batch(item, date, number, add)
--   add = true   (receiving stock) adds the number to the batch of that date,
--                unless it is already there.
--   add = false  (correcting it) replaces it; an empty number clears it.
--   Keyed by product and date, not lot id, like write_off_expiry: stock
--   received offline has no server id yet. A batch that isn't there (boxes
--   still waiting to be counted) is left alone, not an error.
--
-- change_lot_expiry now also carries the number over when two batches join.

alter table public.lots add column batch text check (char_length(batch) <= 120);

-- "A1, B2" + "C3" -> "A1, B2, C3"; a number already in the list is not added twice.
create function public.lot_batch_add(p_cur text, p_new text)
returns text language sql immutable set search_path = public as $$
  select case
    when nullif(btrim(p_new), '') is null then nullif(btrim(p_cur), '')
    when nullif(btrim(p_cur), '') is null then left(btrim(p_new), 120)
    when lower(btrim(p_new)) = any (select lower(btrim(x)) from unnest(string_to_array(p_cur, ',')) x) then p_cur
    else left(p_cur || ', ' || btrim(p_new), 120)
  end
$$;

create function public.set_lot_batch(p_item uuid, p_expiry date, p_batch text, p_add boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_shop uuid;
begin
  select shop_id into v_shop from items where id = p_item;
  if not found or not public.can_write(v_shop) then raise exception 'item not found or shop is read-only'; end if;
  if p_expiry is null then return; end if;
  update lots
     set batch = case when p_add then public.lot_batch_add(batch, p_batch) else nullif(left(btrim(coalesce(p_batch, '')), 120), '') end
   where item_id = p_item and expiry = p_expiry;
end $$;

create or replace function public.change_lot_expiry(p_lot uuid, p_expiry date)
returns void language plpgsql security definer set search_path = public as $$
declare v_lot lots%rowtype; v_to uuid;
begin
  if p_expiry is null then raise exception 'a new expiry date is needed'; end if;
  select * into v_lot from lots where id = p_lot for update;
  if not found or not public.can_write(v_lot.shop_id) then raise exception 'lot not found or shop is read-only'; end if;
  if v_lot.expiry = p_expiry then return; end if;
  select id into v_to from lots where item_id = v_lot.item_id and expiry = p_expiry for update;
  if found then
    update lots set qty = qty + v_lot.qty, batch = public.lot_batch_add(batch, v_lot.batch) where id = v_to;
    delete from lots where id = p_lot;
  else
    update lots set expiry = p_expiry where id = p_lot;
  end if;
end $$;

revoke execute on function public.lot_batch_add(text, text) from public, anon;
revoke execute on function public.set_lot_batch(uuid, date, text, boolean) from public, anon;
grant execute on function public.set_lot_batch(uuid, date, text, boolean) to authenticated;
