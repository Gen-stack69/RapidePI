-- 008: closes two holes found in a security review (2026-11-15).
--
-- * Numbers must be real numbers. Postgres "numeric" also accepts 'NaN' and
--   'Infinity', and nothing refused them: any member could call
--   adjust_stock(item, 'NaN') and the product's stock became NaN for good
--   (NaN plus anything is NaN), and a cost or price of 'Infinity' broke every
--   stock-value total. abs(x) < 'Infinity' is false for NaN and for both
--   infinities (Postgres sorts NaN above every other number), and null still
--   passes, so optional columns keep working.
--
-- * Only the owner changes prices. Item prices and costs were open to staff,
--   while pack and batch prices were already owner-only, so a cashier could
--   set a 500,000 kip bottle to 1 kip, ring it up as a normal online sale with
--   no flag, and put the price back. Changing a price leaves no trace in the
--   movements log, so this could not be found afterwards either. Staff can
--   still add new products and edit names, barcodes, units and stock.

-- ---------- finite numbers ----------

do $$
declare c record;
begin
  for c in select * from (values
      ('items', 'qty'), ('items', 'min_qty'), ('items', 'cost'), ('items', 'cost_orig'),
      ('items', 'price'), ('items', 'price_wholesale'), ('items', 'wholesale_min_qty'),
      ('orders', 'qty'), ('movements', 'qty'),
      ('lots', 'qty'), ('lots', 'price'),
      ('packs', 'size'), ('packs', 'price'),
      ('sales', 'subtotal'), ('sales', 'discount'), ('sales', 'total'), ('sales', 'paid'),
      ('sales', 'change_due'), ('sales', 'vat'), ('sales', 'vat_rate'),
      ('sale_lines', 'qty'), ('sale_lines', 'unit_price'), ('sale_lines', 'line_total'),
      ('sale_lines', 'pack_size'), ('sale_lines', 'pack_qty')
    ) v(tbl, col) loop
    execute format('alter table public.%I add constraint %I check (abs(%I) < ''Infinity''::numeric)',
                   c.tbl, c.tbl || '_' || c.col || '_finite', c.col);
  end loop;
end $$;

-- ---------- prices are the owner's ----------

-- Updates made inside the stock functions only touch qty and updated_at, so
-- they pass. auth.uid() is null for the admin's own SQL, which may fix prices.
create function public.items_price_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_owner(old.shop_id) and (
       new.price             is distinct from old.price
    or new.price_wholesale   is distinct from old.price_wholesale
    or new.wholesale_min_qty is distinct from old.wholesale_min_qty
    or new.cost              is distinct from old.cost
    or new.cost_orig         is distinct from old.cost_orig
    or new.cost_currency     is distinct from old.cost_currency) then
    raise exception 'only the owner can change prices';
  end if;
  return new;
end $$;

create trigger items_price_guard before update on public.items
  for each row execute function public.items_price_guard();

revoke execute on function public.items_price_guard() from public, anon, authenticated;
