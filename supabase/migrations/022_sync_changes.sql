-- 022: devices download only what changed.
--
-- Until now every change in a shop made every open device download the whole
-- shop again (products, batches, 30 days of sales and movements): about 2 MB
-- each time for a small shop, and most of the free plan's 5 GB of egress.
-- Now a device keeps its copy and asks for the rows changed since it last
-- asked:
--
--   updated_at  on every table a device keeps, set by a trigger on every
--               insert and update (whatever the function or app wrote)
--   deleted_rows  one row per deleted row (table, id, when), kept 35 days, so
--               a device learns of deletions too (an emptied batch, a product)
--   sync_changes(shop, since)  the changed rows of every table and the
--               deletions since `since`, plus the server's clock, which the
--               device sends back next time (its own clock may be wrong).
--               With since = null: only the clock (before a full download).
--
-- `since` is taken 2 minutes back: a transaction that started earlier but
-- committed later is not missed. A row seen twice is simply replaced.
-- Sales, sale lines and movements come only from the last 30 days, the same
-- window as the full download.

-- ---------- updated_at everywhere ----------
alter table public.items         add column if not exists updated_at timestamptz not null default now();
alter table public.orders        add column if not exists updated_at timestamptz not null default now();
alter table public.movements     add column if not exists updated_at timestamptz not null default now();
alter table public.settings      add column if not exists updated_at timestamptz not null default now();
alter table public.lots          add column if not exists updated_at timestamptz not null default now();
alter table public.sales         add column if not exists updated_at timestamptz not null default now();
alter table public.sale_lines    add column if not exists updated_at timestamptz not null default now();
alter table public.tills         add column if not exists updated_at timestamptz not null default now();
alter table public.packs         add column if not exists updated_at timestamptz not null default now();
alter table public.pack_receipts add column if not exists updated_at timestamptz not null default now();
alter table public.customers     add column if not exists updated_at timestamptz not null default now();

create function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- deletions ----------
create table public.deleted_rows (
  shop_id    uuid not null,
  tbl        text not null,
  row_id     uuid not null,
  deleted_at timestamptz not null default now()
);
create index deleted_rows_shop_idx on public.deleted_rows (shop_id, deleted_at);
alter table public.deleted_rows enable row level security;
revoke all on public.deleted_rows from anon, authenticated; -- read only through sync_changes

create function public.note_deleted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into deleted_rows (shop_id, tbl, row_id) values (old.shop_id, tg_table_name, old.id);
  return old;
end $$;
revoke execute on function public.touch_updated_at(), public.note_deleted() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['items','orders','movements','settings','lots','sales','sale_lines','tills','packs','pack_receipts','customers'] loop
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.touch_updated_at()',
                   t || '_touch', t);
    execute format('create index if not exists %I on public.%I (shop_id, updated_at)', t || '_shop_updated_idx', t);
    if t <> 'settings' then -- settings has no id and is never deleted
      execute format('create trigger %I after delete on public.%I for each row execute function public.note_deleted()',
                     t || '_note_deleted', t);
    end if;
  end loop;
end $$;

-- ---------- what changed ----------
create function public.sync_changes(p_shop uuid, p_since timestamptz)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_from   timestamptz := p_since - interval '2 minutes';
  v_window timestamptz := now() - interval '30 days';
  v_n      bigint;
begin
  if not public.is_member(p_shop) then raise exception 'not a member of this shop'; end if;
  if p_since is null then return jsonb_build_object('now', now()); end if;
  -- More than a full download would cost: the device downloads the shop instead.
  select (select count(*) from items where shop_id = p_shop and updated_at > v_from)
       + (select count(*) from lots where shop_id = p_shop and updated_at > v_from)
       + (select count(*) from movements where shop_id = p_shop and updated_at > v_from)
       + (select count(*) from sale_lines where shop_id = p_shop and updated_at > v_from)
    into v_n;
  if v_n > 5000 then return jsonb_build_object('now', now(), 'too_many', true); end if;
  return jsonb_build_object(
    'now', now(),
    'items',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from items x where shop_id = p_shop and updated_at > v_from),
    'orders',        (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from orders x where shop_id = p_shop and updated_at > v_from),
    'movements',     (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from movements x
                       where shop_id = p_shop and updated_at > v_from and created_at >= v_window),
    'settings',      (select to_jsonb(x) from settings x where shop_id = p_shop and updated_at > v_from),
    'lots',          (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from lots x where shop_id = p_shop and updated_at > v_from),
    'sales',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sales x
                       where shop_id = p_shop and updated_at > v_from and created_at >= v_window),
    'sale_lines',    (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from sale_lines x
                       where shop_id = p_shop and updated_at > v_from and created_at >= v_window),
    'tills',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from tills x where shop_id = p_shop and updated_at > v_from),
    'packs',         (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from packs x where shop_id = p_shop and updated_at > v_from),
    'pack_receipts', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from pack_receipts x
                       where shop_id = p_shop and updated_at > v_from and (size is null or created_at >= v_window)),
    'customers',     (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from customers x where shop_id = p_shop and updated_at > v_from),
    'shop',          (select jsonb_build_object('id', id, 'name', name, 'plan', plan, 'plan_until', plan_until, 'max_tills', max_tills)
                        from shops where id = p_shop),
    'deleted',       (select coalesce(jsonb_agg(jsonb_build_object('t', tbl, 'id', row_id)), '[]')
                        from deleted_rows where shop_id = p_shop and deleted_at > v_from));
end $$;

-- Old deletions are no use to anyone after 35 days: a device that was away
-- longer than a week downloads the whole shop anyway.
create function public.prune_deleted_rows()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if random() < 0.01 then delete from deleted_rows where deleted_at < now() - interval '35 days'; end if;
  return null;
end $$;
create trigger deleted_rows_prune after insert on public.deleted_rows
  for each statement execute function public.prune_deleted_rows();
revoke execute on function public.prune_deleted_rows() from public, anon, authenticated;

revoke execute on function public.sync_changes(uuid, timestamptz) from public, anon;
grant execute on function public.sync_changes(uuid, timestamptz) to authenticated;
