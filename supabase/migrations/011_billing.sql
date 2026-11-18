-- 011: subscription payments, verified by a Rapide admin.
--
-- Until now a shop was extended by hand-written SQL. Now:
--
-- * plans               what can be bought: price per month and how many tills.
--                       Read by every signed-in user (the app shows the prices).
-- * billing             one row: the text inside RAPIDE's own bank QR, where
--                       shops send their subscription money. Set by an admin.
-- * platform_admins     the Rapide staff who verify payments. Added by hand:
--                         insert into platform_admins (user_id)
--                         select id from auth.users where email = 'you@example.com';
-- * payments            one row per subscription payment. A shop's owner asks
--                       to pay (request_payment): the server sets the amount
--                       from the plan and a reference like RP-1A2B3C4D, which
--                       goes into the transfer's note. The owner taps "I've
--                       paid" (claim_payment). An admin checks the money in the
--                       bank app and approves (approve_payment): the shop gets
--                       the plan's tills and its months added, counted from the
--                       end of its current plan if that hasn't run out yet, so
--                       paying early never loses days. Or the admin rejects it.
--
-- Nobody can write these tables directly; only the functions below change them,
-- and only an admin can approve. A shop owner sees only their own shop's
-- payments. At most one payment per shop waits at a time.

-- ---------- plans ----------

create table public.plans (
  code       text primary key check (code ~ '^[a-z][a-z0-9_]{1,19}$'),
  price_kip  integer not null check (price_kip > 0),
  max_tills  integer not null check (max_tills between 1 and 50),
  active     boolean not null default true,
  sort       integer not null default 0
);
insert into public.plans (code, price_kip, max_tills, sort) values
  ('small', 150000, 1, 1),
  ('mini', 250000, 4, 2);

-- ---------- Rapide's bank QR ----------

create table public.billing (
  id      integer primary key default 1 check (id = 1),
  pay_qr  text check (pay_qr is null or length(pay_qr) between 1 and 512)
);
insert into public.billing (id) values (1);

-- ---------- admins ----------

create table public.platform_admins (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  added_at  timestamptz not null default now()
);

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid());
$$;

-- ---------- payments ----------

create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops (id) on delete cascade,
  plan          text not null references public.plans (code),
  months        integer not null check (months between 1 and 12),
  amount_kip    bigint not null check (amount_kip > 0),
  reference     text not null unique check (reference ~ '^RP-[0-9A-Z]{8}$'),
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by  uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  decided_by    uuid references auth.users (id) on delete set null,
  decided_at    timestamptz,
  note          text check (note is null or length(note) <= 300),
  period_from   timestamptz,
  period_to     timestamptz
);
create unique index payments_one_pending_uidx on public.payments (shop_id) where status = 'pending';
create index payments_shop_idx on public.payments (shop_id, created_at desc);

-- ---------- who sees what ----------

alter table public.plans           enable row level security;
alter table public.billing         enable row level security;
alter table public.platform_admins enable row level security;
alter table public.payments        enable row level security;

create policy plans_select on public.plans for select to authenticated using (true);
create policy billing_select on public.billing for select to authenticated using (true);
-- platform_admins has no policy: only is_platform_admin() reads it.
create policy payments_select on public.payments for select
  using (public.is_member(shop_id) or public.is_platform_admin());

revoke all on public.plans, public.billing, public.platform_admins, public.payments from public, anon, authenticated;
grant select on public.plans, public.billing, public.payments to authenticated;

-- ---------- the owner's side ----------

-- Starts a payment for p_months of p_plan. A payment the shop left waiting is
-- cancelled first, so the shop always pays the newest amount and reference.
-- Works on an expired shop too: that is exactly when it has to pay.
create or replace function public.request_payment(p_shop uuid, p_plan text, p_months integer)
returns public.payments language plpgsql security definer set search_path = public as $$
declare
  v_plan plans;
  v_ref  text;
  v_row  payments;
begin
  if not public.is_owner(p_shop) then raise exception 'only the owner can pay for the shop'; end if;
  select * into v_plan from plans where code = p_plan and active;
  if not found then raise exception 'unknown plan'; end if;
  if p_months is null or p_months not between 1 and 12 then raise exception 'months must be 1 to 12'; end if;

  update payments set status = 'cancelled', decided_at = now()
   where shop_id = p_shop and status = 'pending';

  loop
    v_ref := 'RP-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from payments where reference = v_ref);
  end loop;

  insert into payments (shop_id, plan, months, amount_kip, reference, requested_by)
  values (p_shop, v_plan.code, p_months, v_plan.price_kip::bigint * p_months, v_ref, auth.uid())
  returning * into v_row;
  return v_row;
end $$;

-- "I've paid": tells the admin the money should be in the bank now.
create or replace function public.claim_payment(p_id uuid)
returns public.payments language plpgsql security definer set search_path = public as $$
declare v_row payments;
begin
  select * into v_row from payments where id = p_id for update;
  if not found or not public.is_owner(v_row.shop_id) then raise exception 'payment not found'; end if;
  if v_row.status <> 'pending' then raise exception 'payment already decided'; end if;
  update payments set claimed_at = coalesce(claimed_at, now()) where id = p_id returning * into v_row;
  return v_row;
end $$;

create or replace function public.cancel_payment(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_row payments;
begin
  select * into v_row from payments where id = p_id for update;
  if not found or not public.is_owner(v_row.shop_id) then raise exception 'payment not found'; end if;
  if v_row.status <> 'pending' then raise exception 'payment already decided'; end if;
  update payments set status = 'cancelled', decided_at = now() where id = p_id;
end $$;

-- ---------- the admin's side ----------

-- The money is in the bank: give the shop its plan. Months are added to
-- whichever is later, now or the end of the current plan.
create or replace function public.approve_payment(p_id uuid, p_note text default null)
returns public.payments language plpgsql security definer set search_path = public as $$
declare
  v_row  payments;
  v_shop shops;
  v_from timestamptz;
  v_to   timestamptz;
begin
  if not public.is_platform_admin() then raise exception 'only a Rapide admin can approve payments'; end if;
  select * into v_row from payments where id = p_id for update;
  if not found then raise exception 'payment not found'; end if;
  if v_row.status <> 'pending' then raise exception 'payment already decided'; end if;
  select * into v_shop from shops where id = v_row.shop_id for update;

  v_from := greatest(now(), v_shop.plan_until);
  v_to   := v_from + make_interval(months => v_row.months);

  update shops
     set plan = 'paid', plan_until = v_to,
         max_tills = (select max_tills from plans where code = v_row.plan)
   where id = v_row.shop_id;
  update payments
     set status = 'approved', decided_by = auth.uid(), decided_at = now(),
         note = nullif(trim(p_note), ''), period_from = v_from, period_to = v_to
   where id = p_id
  returning * into v_row;
  return v_row;
end $$;

-- The money never arrived, or the amount was wrong.
create or replace function public.reject_payment(p_id uuid, p_note text default null)
returns public.payments language plpgsql security definer set search_path = public as $$
declare v_row payments;
begin
  if not public.is_platform_admin() then raise exception 'only a Rapide admin can reject payments'; end if;
  select * into v_row from payments where id = p_id for update;
  if not found then raise exception 'payment not found'; end if;
  if v_row.status <> 'pending' then raise exception 'payment already decided'; end if;
  update payments
     set status = 'rejected', decided_by = auth.uid(), decided_at = now(), note = nullif(trim(p_note), '')
   where id = p_id
  returning * into v_row;
  return v_row;
end $$;

-- Every payment with its shop and the owner's email, for the admin screen.
-- Waiting payments come first: the ones marked as paid, oldest first.
create or replace function public.admin_payments(p_limit integer default 200)
returns table (
  id uuid, shop_id uuid, shop_name text, owner_email text, plan text, months integer,
  amount_kip bigint, reference text, status text, created_at timestamptz,
  claimed_at timestamptz, decided_at timestamptz, note text, plan_until timestamptz
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'only a Rapide admin can see all payments'; end if;
  return query
    select p.id, p.shop_id, s.name, (
             select u.email::text from members m join auth.users u on u.id = m.user_id
              where m.shop_id = p.shop_id and m.role = 'owner' order by m.user_id limit 1),
           p.plan, p.months, p.amount_kip, p.reference, p.status, p.created_at,
           p.claimed_at, p.decided_at, p.note, s.plan_until
      from payments p join shops s on s.id = p.shop_id
     order by (p.status = 'pending') desc, (p.claimed_at is null), coalesce(p.claimed_at, p.created_at)
     limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end $$;

create or replace function public.set_billing_qr(p_qr text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'only a Rapide admin can change the billing QR'; end if;
  update billing set pay_qr = nullif(p_qr, '') where id = 1;
end $$;

revoke execute on function
  public.is_platform_admin(), public.request_payment(uuid, text, integer), public.claim_payment(uuid),
  public.cancel_payment(uuid), public.approve_payment(uuid, text), public.reject_payment(uuid, text),
  public.admin_payments(integer), public.set_billing_qr(text)
from public, anon;
grant execute on function
  public.is_platform_admin(), public.request_payment(uuid, text, integer), public.claim_payment(uuid),
  public.cancel_payment(uuid), public.approve_payment(uuid, text), public.reject_payment(uuid, text),
  public.admin_payments(integer), public.set_billing_qr(text)
to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.payments;
  end if;
end $$;
