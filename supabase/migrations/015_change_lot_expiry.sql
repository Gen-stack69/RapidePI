-- 015: correct the expiry date of a batch already in stock.
--
-- change_lot_expiry(lot, date)  moves the whole batch to the new date. The
--   quantity stays the same. When the product already has a batch with that
--   date, the two become one (that batch keeps its own special price).
--   Anyone who may change the shop's stock may do it, like receiving stock.
--   No stock movement is written: nothing came in or went out.

create function public.change_lot_expiry(p_lot uuid, p_expiry date)
returns void language plpgsql security definer set search_path = public as $$
declare v_lot lots%rowtype; v_to uuid;
begin
  if p_expiry is null then raise exception 'a new expiry date is needed'; end if;
  select * into v_lot from lots where id = p_lot for update;
  if not found or not public.can_write(v_lot.shop_id) then raise exception 'lot not found or shop is read-only'; end if;
  if v_lot.expiry = p_expiry then return; end if;
  select id into v_to from lots where item_id = v_lot.item_id and expiry = p_expiry for update;
  if found then
    update lots set qty = qty + v_lot.qty where id = v_to;
    delete from lots where id = p_lot;
  else
    update lots set expiry = p_expiry where id = p_lot;
  end if;
end $$;

revoke execute on function public.change_lot_expiry(uuid, date) from public, anon;
grant execute on function public.change_lot_expiry(uuid, date) to authenticated;
