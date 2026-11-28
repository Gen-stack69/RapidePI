-- 025: why stock left, no expired stock at the till, one barcode per product.
-- QA pass of 2026-11-28, issues 3 and 4, and the server half of issue 1.
--
-- 1. Reasons. Stock taken out by hand, a void and a write-off say why
--    (reason_code, and reason_text for "other"), and who (created_by, already
--    there). New versions of adjust_stock, void_sale, void_sale_by_client and
--    write_off_expiry take p_reason and refuse to remove stock without one.
--    The versions without it stay for now: the app already installed on
--    phones, and work still queued on them offline, call those. Drop them in
--    a later migration once every device runs the new app.
--    The reason reaches the movements through a setting of the transaction
--    (rapide.reason), filled in by a trigger, so stock_move and the rest
--    stay as they are.
-- 2. Expired stock. create_sale refuses units from an expired batch unless the
--    shop allows it (settings.sell_expired, off by default). A sale made
--    offline always goes through (the goods are gone), flagged 'expired', as
--    is a sale of expired stock that the shop allows.
-- 3. One barcode, one product: a product's barcode (or code) may not be
--    another product's, nor on a box of another product; a box's barcode may
--    not be another product's, nor another box's. Checked when it changes,
--    so products saved before this are not blocked until their barcode is.

-- ---------- 1. reasons ----------
alter table public.movements
  add column reason_code text check (reason_code is null or reason_code in (
    'damaged', 'expired', 'theft', 'own_use', 'count', 'returned',
    'wrong_item', 'changed_mind', 'duplicate', 'other')),
  add column reason_text text check (reason_text is null or length(reason_text) <= 200);
alter table public.sales
  add column void_reason text,
  add column void_reason_text text,
  add column voided_by uuid;

-- The reason given to the function now running, or null.
create function public.move_reason()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.reason_code is null then
    new.reason_code := nullif(current_setting('rapide.reason', true), '');
    new.reason_text := nullif(current_setting('rapide.reason_text', true), '');
  end if;
  return new;
end $$;
create trigger movements_reason before insert on public.movements
  for each row execute function public.move_reason();

-- Check a reason (the codes allowed for what is being done) and hand it to
-- the movements written next in this transaction.
create function public.use_reason(p_code text, p_text text, p_allowed text[])
returns void language plpgsql set search_path = public as $$
declare v_text text := nullif(left(btrim(coalesce(p_text, '')), 200), '');
begin
  if p_code is null or btrim(p_code) = '' then
    raise exception 'a reason is needed' using errcode = 'P0001';
  end if;
  if not p_code = any(p_allowed) then raise exception 'unknown reason: %', p_code; end if;
  if p_code = 'other' and v_text is null then
    raise exception 'a reason is needed' using errcode = 'P0001';
  end if;
  perform set_config('rapide.reason', p_code, true);
  perform set_config('rapide.reason_text', coalesce(v_text, ''), true);
end $$;

create function public.clear_reason()
returns void language sql set search_path = public as $$
  select set_config('rapide.reason', '', true), set_config('rapide.reason_text', '', true);
$$;

-- Stock in or out by hand. Taking stock out by hand ('manual') needs a reason.
create function public.adjust_stock(
  p_item uuid, p_delta numeric, p_note text, p_expiry date, p_client_id text,
  p_at timestamptz, p_offline boolean, p_reason text, p_reason_text text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_q numeric;
begin
  -- (p_at and p_offline have no default here, so a call that leaves them
  -- out can only be the old adjust_stock above, never this one)
  if (p_delta < 0 and coalesce(p_note, '') = 'manual') or p_reason is not null then
    perform public.use_reason(p_reason, p_reason_text,
      array['damaged', 'expired', 'theft', 'own_use', 'count', 'returned', 'other']);
  end if;
  v_q := public.adjust_stock(p_item, p_delta, p_note, p_expiry, p_client_id, p_at, p_offline);
  perform public.clear_reason();
  return v_q;
end $$;

create function public.void_sale(p_sale uuid, p_reason text, p_reason_text text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.use_reason(p_reason, p_reason_text, array['wrong_item', 'changed_mind', 'duplicate', 'other']);
  perform public.void_sale(p_sale);
  update sales set void_reason = p_reason, void_reason_text = nullif(btrim(coalesce(p_reason_text, '')), ''),
                   voided_by = auth.uid()
   where id = p_sale;
  perform public.clear_reason();
end $$;

create function public.void_sale_by_client(
  p_shop uuid, p_sale_client_id text, p_at timestamptz, p_reason text, p_reason_text text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_was text;
begin
  perform public.use_reason(p_reason, p_reason_text, array['wrong_item', 'changed_mind', 'duplicate', 'other']);
  select status into v_was from sales where shop_id = p_shop and client_id = p_sale_client_id;
  perform public.void_sale_by_client(p_shop, p_sale_client_id, p_at);
  -- sent twice (offline queue): the first reason stays
  if v_was is distinct from 'void' then
    update sales set void_reason = p_reason, void_reason_text = nullif(btrim(coalesce(p_reason_text, '')), ''),
                     voided_by = auth.uid()
     where shop_id = p_shop and client_id = p_sale_client_id;
  end if;
  perform public.clear_reason();
end $$;

create function public.write_off_expiry(
  p_item uuid, p_expiry date, p_qty numeric, p_note text, p_client_id text,
  p_at timestamptz, p_reason text, p_reason_text text default null)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_q numeric;
begin
  perform public.use_reason(p_reason, p_reason_text,
    array['damaged', 'expired', 'theft', 'own_use', 'count', 'returned', 'other']);
  v_q := public.write_off_expiry(p_item, p_expiry, p_qty, p_note, p_client_id, p_at);
  perform public.clear_reason();
  return v_q;
end $$;

revoke execute on function public.move_reason() from public, anon, authenticated;
revoke execute on function public.use_reason(text, text, text[]) from public, anon, authenticated;
revoke execute on function public.clear_reason() from public, anon, authenticated;
revoke execute on function public.adjust_stock(uuid, numeric, text, date, text, timestamptz, boolean, text, text) from public, anon;
revoke execute on function public.void_sale(uuid, text, text) from public, anon;
revoke execute on function public.void_sale_by_client(uuid, text, timestamptz, text, text) from public, anon;
revoke execute on function public.write_off_expiry(uuid, date, numeric, text, text, timestamptz, text, text) from public, anon;
grant execute on function public.adjust_stock(uuid, numeric, text, date, text, timestamptz, boolean, text, text) to authenticated;
grant execute on function public.void_sale(uuid, text, text) to authenticated;
grant execute on function public.void_sale_by_client(uuid, text, timestamptz, text, text) to authenticated;
grant execute on function public.write_off_expiry(uuid, date, numeric, text, text, timestamptz, text, text) to authenticated;

-- ---------- 2. expired stock at the till ----------
alter table public.settings add column sell_expired boolean not null default false;
grant update (sell_expired) on public.settings to authenticated;

-- create_sale_core (006, renamed in 007) with the expired-stock rule.
create or replace function public.create_sale_core(
  p_shop uuid, p_client_id text, p_lines jsonb,
  p_discount numeric default 0, p_method text default 'cash', p_paid numeric default 0,
  p_at timestamptz default null, p_till text default null, p_till_no integer default null,
  p_offline boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_sale  uuid;
  v_no    integer;
  v_sub   numeric := 0;
  v_total numeric;
  v_disc  numeric := coalesce(p_discount, 0);
  v_paid  numeric := coalesce(p_paid, 0);
  v_off   boolean := coalesce(p_offline, false);
  v_item  items%rowtype;
  v_pack  packs%rowtype;
  v_price numeric;
  v_lotp  numeric;
  v_base  numeric;
  v_ws    boolean;
  v_flags text[] := '{}';
  v_t     record;
  v_ret   timestamptz;
  v_rate  numeric;
  v_sellx boolean;
  v_today date := (now() at time zone 'Asia/Vientiane')::date;
  v_old   numeric;
  r       record;
begin
  if not public.can_write(p_shop) then raise exception 'shop is read-only'; end if;
  select id into v_sale from sales where shop_id = p_shop and client_id = p_client_id;
  if found then return v_sale; end if;
  if p_method not in ('cash', 'transfer') then raise exception 'unknown payment method'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'the sale has no products';
  end if;
  select * into v_t from public.device_time(p_at);
  if v_t.v_bad then v_flags := v_flags || 'clock'::text; end if;
  select coalesce(sell_expired, false) into v_sellx from settings where shop_id = p_shop;
  v_sellx := coalesce(v_sellx, false);

  if p_till is null then raise exception 'this device is not a till'; end if;
  select retired_at into v_ret from tills where shop_id = p_shop and code = p_till for update;
  if not found then raise exception 'unknown till: %', p_till; end if;
  if v_ret is not null and not (v_off and v_t.v_at < v_ret) then
    raise exception 'till retired: %', p_till;
  end if;
  update tills set last_no = greatest(last_no, coalesce(p_till_no, 0))
  where shop_id = p_shop and code = p_till;

  update shops set receipt_seq = receipt_seq + 1 where id = p_shop returning receipt_seq into v_no;
  insert into sales (shop_id, client_id, receipt_no, method, till, till_no, created_at)
  values (p_shop, p_client_id, v_no, p_method, p_till, p_till_no, v_t.v_at) returning id into v_sale;

  -- One line per product, pack and batch; sorted by product so two tills
  -- selling the same products lock them in the same order.
  for r in select (l->>'item_id')::uuid item_id,
                  nullif(l->>'pack_id', '')::uuid pack_id,
                  case when nullif(l->>'pack_id', '') is null then nullif(l->>'expiry', '')::date end expiry,
                  sum((l->>'qty')::numeric) qty, max((l->>'price')::numeric) price
           from jsonb_array_elements(p_lines) l group by 1, 2, 3
           order by 1, 2 nulls first, 3 nulls first loop
    if r.qty is null or r.qty <= 0 then raise exception 'quantity must be more than zero'; end if;
    select * into v_item from items where id = r.item_id and shop_id = p_shop for update;
    if not found then raise exception 'item not found or shop is read-only'; end if;
    v_ws := false;
    if r.pack_id is not null then
      select * into v_pack from packs where id = r.pack_id and item_id = r.item_id;
      if not found then raise exception 'pack not found'; end if;
      v_base := r.qty * v_pack.size;
      v_price := v_pack.price;
    else
      v_pack := null;
      v_base := r.qty;
      v_lotp := null;
      if r.expiry is not null then
        select price into v_lotp from lots where item_id = r.item_id and expiry = r.expiry;
      end if;
      if v_lotp is not null then
        v_price := v_lotp;
      else
        v_ws := v_item.price_wholesale > 0 and v_item.wholesale_min_qty > 0
                and r.qty >= v_item.wholesale_min_qty;
        v_price := case when v_ws then v_item.price_wholesale else v_item.price end;
      end if;
    end if;
    if v_off and r.price is not null and r.price >= 0 then
      if r.price <> v_price and not 'price_changed' = any(v_flags) then
        v_flags := v_flags || 'price_changed'::text;
      end if;
      v_price := r.price;
    elsif v_price <= 0 then
      raise exception 'no sell price: %', v_item.sku;
    end if;
    if v_off and v_item.qty < v_base and not 'short' = any(v_flags) then
      v_flags := v_flags || 'short'::text;
    end if;
    -- 025: stock_move takes in-date stock first; expired units go only when
    -- there is not enough of it, or when this line is an expired batch.
    select coalesce(sum(qty), 0) into v_old from lots where item_id = r.item_id and expiry < v_today;
    if (r.expiry is not null and r.expiry < v_today) or (v_old > 0 and v_base > v_item.qty - v_old) then
      if not v_off and not v_sellx then
        raise exception 'expired stock: % has % in date', v_item.sku, greatest(v_item.qty - v_old, 0)
          using errcode = 'P0001';
      end if;
      if not 'expired' = any(v_flags) then v_flags := v_flags || 'expired'::text; end if;
    end if;
    perform public.stock_move(r.item_id, -v_base, 'sale', null, v_sale, v_off, v_t.v_at, r.expiry);
    insert into sale_lines (shop_id, sale_id, item_id, sku, name, qty, unit_price, wholesale, line_total,
                            pack_id, pack_name, pack_size, pack_qty, expiry, created_at)
    values (p_shop, v_sale, r.item_id, v_item.sku, v_item.name, v_base, r.qty * v_price / v_base, v_ws,
            r.qty * v_price, v_pack.id, v_pack.name, v_pack.size,
            case when v_pack.id is not null then r.qty end, r.expiry, v_t.v_at);
    v_sub := v_sub + r.qty * v_price;
  end loop;

  if v_disc < 0 or v_disc > v_sub then raise exception 'discount must be between 0 and the subtotal'; end if;
  v_total := v_sub - v_disc;
  if p_method = 'cash' then
    if v_paid < v_total then raise exception 'cash paid is less than the total'; end if;
  else
    v_paid := v_total;
  end if;
  -- VAT is inside the price: the part of the total that is tax.
  select coalesce(vat_rate, 0) into v_rate from settings where shop_id = p_shop;
  v_rate := coalesce(v_rate, 0);
  update sales set subtotal = v_sub, discount = v_disc, total = v_total,
                   paid = v_paid, change_due = v_paid - v_total, flags = v_flags,
                   vat_rate = v_rate, vat = round(v_total * v_rate / (100 + v_rate), 2)
  where id = v_sale;
  return v_sale;
end $$;

-- ---------- 3. one barcode, one product ----------
create function public.barcode_owner(p_shop uuid, p_code text, p_item uuid, p_pack uuid, p_any_pack boolean)
returns text language sql stable set search_path = public as $$
  select coalesce(
    (select name from items
      where shop_id = p_shop and id is distinct from p_item
        and (lower(btrim(barcode)) = lower(btrim(p_code)) or lower(btrim(sku)) = lower(btrim(p_code)))
      limit 1),
    (select i.name from packs p join items i on i.id = p.item_id
      where p.shop_id = p_shop and p.id is distinct from p_pack
        and (p_any_pack or p.item_id is distinct from p_item)
        and lower(btrim(p.barcode)) = lower(btrim(p_code))
      limit 1));
$$;

create function public.items_one_barcode()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_code text := coalesce(nullif(btrim(new.barcode), ''), new.sku); v_name text;
begin
  if tg_op = 'UPDATE' and new.barcode is not distinct from old.barcode and new.sku is not distinct from old.sku then
    return new;
  end if;
  -- a product's own box may carry its barcode (many cartons do)
  v_name := public.barcode_owner(new.shop_id, v_code, new.id, null, false);
  if v_name is not null then
    raise exception 'barcode taken: %', v_name using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger items_one_barcode before insert or update of barcode, sku on public.items
  for each row execute function public.items_one_barcode();

create function public.packs_one_barcode()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if nullif(btrim(new.barcode), '') is null then return new; end if;
  if tg_op = 'UPDATE' and new.barcode is not distinct from old.barcode then return new; end if;
  v_name := public.barcode_owner(new.shop_id, new.barcode, new.item_id, new.id, true);
  if v_name is not null then
    raise exception 'barcode taken: %', v_name using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger packs_one_barcode before insert or update of barcode on public.packs
  for each row execute function public.packs_one_barcode();

revoke execute on function public.barcode_owner(uuid, text, uuid, uuid, boolean) from public, anon, authenticated;
revoke execute on function public.items_one_barcode() from public, anon, authenticated;
revoke execute on function public.packs_one_barcode() from public, anon, authenticated;
