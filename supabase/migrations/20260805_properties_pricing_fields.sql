-- Add explicit pricing fields to properties for sales and rentals.

begin;

alter table if exists public.properties
  add column if not exists asking_price numeric(12, 2),
  add column if not exists monthly_rent numeric(12, 2);

alter table if exists public.properties
  drop constraint if exists properties_asking_price_check,
  drop constraint if exists properties_monthly_rent_check;

alter table if exists public.properties
  add constraint properties_asking_price_check check (asking_price is null or asking_price >= 0),
  add constraint properties_monthly_rent_check check (monthly_rent is null or monthly_rent >= 0);

create index if not exists properties_workspace_asking_price_idx
  on public.properties (workspace_id, asking_price);

create index if not exists properties_workspace_monthly_rent_idx
  on public.properties (workspace_id, monthly_rent);

commit;
