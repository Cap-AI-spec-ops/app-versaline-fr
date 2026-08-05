-- Stable workspace properties schema + image storage policies.

begin;

create table if not exists public.properties (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid null references public.profiles(id) on delete set null,
  reference text,
  title text,
  name text,
  address_line1 text not null,
  address_line2 text,
  address text,
  street_address text,
  city text not null,
  town text,
  neighborhood text,
  district text,
  area text,
  postal_code text,
  zip_code text,
  zipcode text,
  property_type text,
  type text,
  rooms numeric(8, 2),
  room_count numeric(8, 2),
  bedrooms numeric(8, 2),
  bathrooms numeric(8, 2),
  bathroom_count numeric(8, 2),
  loi_carrez_surface_sqm numeric(12, 2),
  carrez_surface numeric(12, 2),
  surface_area numeric(12, 2),
  surface numeric(12, 2),
  habitable_surface_sqm numeric(12, 2),
  cadastre_reference text,
  cadastre text,
  parcel_reference text,
  dpe_energy_rating text,
  dpe_rating text,
  energy_rating text,
  dpe_climate_rating text,
  ges_rating text,
  climate_rating text,
  furnished_inventory_included boolean,
  image_paths text[] not null default '{}',
  cover_image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'properties'
  ) then
    alter table public.properties
      add column if not exists created_by uuid null references public.profiles(id) on delete set null,
      add column if not exists reference text,
      add column if not exists title text,
      add column if not exists name text,
      add column if not exists address_line1 text,
      add column if not exists address_line2 text,
      add column if not exists address text,
      add column if not exists street_address text,
      add column if not exists city text,
      add column if not exists town text,
      add column if not exists neighborhood text,
      add column if not exists district text,
      add column if not exists area text,
      add column if not exists postal_code text,
      add column if not exists zip_code text,
      add column if not exists zipcode text,
      add column if not exists property_type text,
      add column if not exists type text,
      add column if not exists rooms numeric(8, 2),
      add column if not exists room_count numeric(8, 2),
      add column if not exists bedrooms numeric(8, 2),
      add column if not exists bathrooms numeric(8, 2),
      add column if not exists bathroom_count numeric(8, 2),
      add column if not exists loi_carrez_surface_sqm numeric(12, 2),
      add column if not exists carrez_surface numeric(12, 2),
      add column if not exists surface_area numeric(12, 2),
      add column if not exists surface numeric(12, 2),
      add column if not exists habitable_surface_sqm numeric(12, 2),
      add column if not exists cadastre_reference text,
      add column if not exists cadastre text,
      add column if not exists parcel_reference text,
      add column if not exists dpe_energy_rating text,
      add column if not exists dpe_rating text,
      add column if not exists energy_rating text,
      add column if not exists dpe_climate_rating text,
      add column if not exists ges_rating text,
      add column if not exists climate_rating text,
      add column if not exists furnished_inventory_included boolean,
      add column if not exists image_paths text[] not null default '{}',
      add column if not exists cover_image_path text,
      add column if not exists created_at timestamptz not null default now(),
      add column if not exists updated_at timestamptz not null default now();

    update public.properties
    set image_paths = '{}'
    where image_paths is null;

    update public.properties
    set address_line1 = coalesce(nullif(address_line1, ''), nullif(address, ''), nullif(street_address, ''), 'Unknown address')
    where address_line1 is null or btrim(address_line1) = '';

    update public.properties
    set city = coalesce(nullif(city, ''), nullif(town, ''), 'Unknown city')
    where city is null or btrim(city) = '';

    alter table public.properties
      alter column image_paths set default '{}',
      alter column image_paths set not null,
      alter column address_line1 set not null,
      alter column city set not null,
      alter column created_at set default now(),
      alter column updated_at set default now();
  end if;
end
$$;

create index if not exists properties_workspace_idx
  on public.properties (workspace_id);

create index if not exists properties_workspace_updated_idx
  on public.properties (workspace_id, updated_at desc);

create index if not exists properties_workspace_city_idx
  on public.properties (workspace_id, city);

create index if not exists properties_workspace_reference_idx
  on public.properties (workspace_id, reference);

create index if not exists properties_workspace_type_idx
  on public.properties (workspace_id, property_type);

alter table public.properties enable row level security;

drop policy if exists "properties_select" on public.properties;
create policy "properties_select"
on public.properties
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "properties_insert" on public.properties;
create policy "properties_insert"
on public.properties
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "properties_update" on public.properties;
create policy "properties_update"
on public.properties
for update
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "properties_delete" on public.properties;
create policy "properties_delete"
on public.properties
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

grant select, insert, update, delete on table public.properties to authenticated;

create or replace function public.set_updated_at_properties()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_properties on public.properties;
create trigger trg_set_updated_at_properties
before update on public.properties
for each row
execute function public.set_updated_at_properties();

insert into storage.buckets (id, name, public)
values ('property-images', 'property-images', false)
on conflict (id) do nothing;

drop policy if exists "property_images_select" on storage.objects;
create policy "property_images_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'property-images'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "property_images_insert" on storage.objects;
create policy "property_images_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'property-images'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "property_images_update" on storage.objects;
create policy "property_images_update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'property-images'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead', 'agent')
)
with check (
  bucket_id = 'property-images'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "property_images_delete" on storage.objects;
create policy "property_images_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'property-images'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead', 'agent')
);

commit;
