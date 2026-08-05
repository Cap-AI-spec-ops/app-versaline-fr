-- CRM contact enrichment: multi-role, buyer detail fields, and timeline search support.

begin;

create extension if not exists pg_trgm;

alter table if exists public.crm_contacts
  add column if not exists contact_roles text[];

alter table if exists public.crm_contacts
  add column if not exists buyer_target_locations text[];

alter table if exists public.crm_contacts
  add column if not exists buyer_property_types text[];

alter table if exists public.crm_contacts
  add column if not exists buyer_budget_min numeric(12, 2);

alter table if exists public.crm_contacts
  add column if not exists buyer_budget_max numeric(12, 2);

alter table if exists public.crm_contacts
  add column if not exists buyer_bedrooms_min integer;

alter table if exists public.crm_contacts
  add column if not exists buyer_surface_min_m2 numeric(10, 2);

alter table if exists public.crm_contacts
  add column if not exists buyer_move_in_window text;

alter table if exists public.crm_contacts
  add column if not exists buyer_country_details jsonb;

alter table if exists public.crm_contacts
  add column if not exists tenant_target_locations text[];

alter table if exists public.crm_contacts
  add column if not exists tenant_property_types text[];

alter table if exists public.crm_contacts
  add column if not exists tenant_budget_min numeric(12, 2);

alter table if exists public.crm_contacts
  add column if not exists tenant_budget_max numeric(12, 2);

alter table if exists public.crm_contacts
  add column if not exists tenant_bedrooms_min integer;

alter table if exists public.crm_contacts
  add column if not exists tenant_surface_min_m2 numeric(10, 2);

alter table if exists public.crm_contacts
  add column if not exists tenant_move_in_window text;

alter table if exists public.crm_contacts
  add column if not exists tenant_country_details jsonb;

update public.crm_contacts
set contact_roles = array[client_type]
where contact_roles is null
  and client_type in ('buyer', 'seller', 'tenant', 'landlord', 'investor', 'vendor', 'other');

update public.crm_contacts
set contact_roles = array['other']
where contact_roles is null
   or cardinality(contact_roles) = 0;

alter table if exists public.crm_contacts
  drop constraint if exists crm_contacts_roles_check;

alter table if exists public.crm_contacts
  add constraint crm_contacts_roles_check
  check (
    contact_roles is not null
    and cardinality(contact_roles) >= 1
    and contact_roles <@ array['buyer', 'seller', 'tenant', 'landlord', 'investor', 'vendor', 'other']::text[]
  );

alter table if exists public.crm_contacts
  drop constraint if exists crm_contacts_buyer_budget_bounds_check;

alter table if exists public.crm_contacts
  add constraint crm_contacts_buyer_budget_bounds_check
  check (
    buyer_budget_min is null
    or buyer_budget_max is null
    or buyer_budget_min <= buyer_budget_max
  );

alter table if exists public.crm_contacts
  drop constraint if exists crm_contacts_buyer_numeric_bounds_check;

alter table if exists public.crm_contacts
  add constraint crm_contacts_buyer_numeric_bounds_check
  check (
    (buyer_bedrooms_min is null or buyer_bedrooms_min >= 0)
    and (buyer_surface_min_m2 is null or buyer_surface_min_m2 >= 0)
  );

alter table if exists public.crm_contacts
  drop constraint if exists crm_contacts_tenant_budget_bounds_check;

alter table if exists public.crm_contacts
  add constraint crm_contacts_tenant_budget_bounds_check
  check (
    tenant_budget_min is null
    or tenant_budget_max is null
    or tenant_budget_min <= tenant_budget_max
  );

alter table if exists public.crm_contacts
  drop constraint if exists crm_contacts_tenant_numeric_bounds_check;

alter table if exists public.crm_contacts
  add constraint crm_contacts_tenant_numeric_bounds_check
  check (
    (tenant_bedrooms_min is null or tenant_bedrooms_min >= 0)
    and (tenant_surface_min_m2 is null or tenant_surface_min_m2 >= 0)
  );

create index if not exists crm_contacts_roles_idx
  on public.crm_contacts using gin (contact_roles);

create index if not exists crm_contacts_buyer_locations_idx
  on public.crm_contacts using gin (buyer_target_locations);

create index if not exists crm_contacts_tenant_locations_idx
  on public.crm_contacts using gin (tenant_target_locations);

create index if not exists crm_contact_events_title_body_trgm_idx
  on public.crm_contact_events using gin ((coalesce(title, '') || ' ' || coalesce(body, '')) gin_trgm_ops);

commit;
