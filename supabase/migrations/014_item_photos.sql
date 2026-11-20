-- 014: an optional photo of each product.
--
-- * items.photo  where the product's picture is stored, in the private Storage
--                bucket product-photos: <shop id>/<item id>-<stamp>.jpg. A new
--                photo gets a new name, so no phone shows an old cached one.
-- * Anyone who may change the shop's products may set, change or remove the
--   photo; every member of the shop may see it. Nobody else, no public links.
--
-- The storage part only runs where Supabase Storage exists (not in the tests).

alter table public.items
  add column photo text check (photo is null or photo ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-z]{1,16}\.jpg$');
grant insert (photo), update (photo) on public.items to authenticated;

-- The picture must be this product's own file in this shop's folder.
create or replace function public.items_photo_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.photo is not null and new.photo not like new.shop_id::text || '/' || new.id::text || '-%' then
    raise exception 'product photo must be the product''s own file';
  end if;
  return new;
end $$;
create trigger items_photo_guard before insert or update of photo on public.items
  for each row execute function public.items_photo_guard();

-- ---------- the private bucket (Supabase only) ----------

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('product-photos', 'product-photos', false, 524288, array['image/jpeg'])
    on conflict (id) do update set public = false, file_size_limit = 524288, allowed_mime_types = array['image/jpeg'];

    execute $p$drop policy if exists product_photos_select on storage.objects$p$;
    execute $p$drop policy if exists product_photos_insert on storage.objects$p$;
    execute $p$drop policy if exists product_photos_update on storage.objects$p$;
    execute $p$drop policy if exists product_photos_delete on storage.objects$p$;
    -- proof_shop() (012) reads the shop id from the first part of the path.
    execute $p$create policy product_photos_select on storage.objects for select to authenticated
      using (bucket_id = 'product-photos' and public.is_member(public.proof_shop(name)))$p$;
    execute $p$create policy product_photos_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'product-photos' and public.can_write(public.proof_shop(name)))$p$;
    execute $p$create policy product_photos_update on storage.objects for update to authenticated
      using (bucket_id = 'product-photos' and public.can_write(public.proof_shop(name)))
      with check (bucket_id = 'product-photos' and public.can_write(public.proof_shop(name)))$p$;
    execute $p$create policy product_photos_delete on storage.objects for delete to authenticated
      using (bucket_id = 'product-photos' and public.can_write(public.proof_shop(name)))$p$;
  end if;
end $$;
