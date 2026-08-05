-- Remove deprecated vendor CRM role.

begin;

update public.crm_contacts
set client_type = 'other'
where client_type = 'vendor';

update public.crm_contacts
set contact_roles = array_remove(contact_roles, 'vendor')
where contact_roles is not null
  and 'vendor' = any(contact_roles);

update public.crm_contacts
set contact_roles = array['other']
where contact_roles is null
   or cardinality(contact_roles) = 0;

alter table if exists public.crm_contacts
  drop constraint if exists crm_contacts_client_type_check;

alter table if exists public.crm_contacts
  add constraint crm_contacts_client_type_check
  check (client_type in ('buyer', 'seller', 'tenant', 'landlord', 'investor', 'other'));

alter table if exists public.crm_contacts
  drop constraint if exists crm_contacts_roles_check;

alter table if exists public.crm_contacts
  add constraint crm_contacts_roles_check
  check (
    contact_roles is not null
    and cardinality(contact_roles) >= 1
    and contact_roles <@ array['buyer', 'seller', 'tenant', 'landlord', 'investor', 'other']::text[]
  );

commit;
