-- Receiving an inbound order can carry the expiry date of what arrived.
--
-- Until now complete_order() added the stock with no date, so the goods of an
-- inbound order never reached the Expiry screen. p_expiry is optional and only
-- used for an inbound order ('in'); an outbound order takes stock as before,
-- earliest expiry first.
--
-- Dropped first: adding a parameter with a default would otherwise create a
-- second function and make one-argument calls ambiguous (as in 002). Calls
-- with only p_order, from devices still on the older app, keep working.
drop function public.complete_order(uuid);
create function public.complete_order(p_order uuid, p_expiry date default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_o orders%rowtype;
begin
  select * into v_o from orders where id = p_order for update;
  if not found or not public.can_write(v_o.shop_id) then
    raise exception 'order not found or shop is read-only';
  end if;
  if v_o.status <> 'pending' then raise exception 'order already completed'; end if;
  perform public.adjust_stock(
    v_o.item_id,
    case when v_o.type = 'in' then v_o.qty else -v_o.qty end,
    'order',
    case when v_o.type = 'in' then p_expiry end);
  update orders set status = 'done', completed_at = now() where id = p_order;
end $$;

revoke execute on function public.complete_order(uuid, date) from public, anon;
grant execute on function public.complete_order(uuid, date) to authenticated;
