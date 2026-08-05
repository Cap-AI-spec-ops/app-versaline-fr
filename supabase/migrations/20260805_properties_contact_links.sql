-- Link properties to seller or tenant CRM contacts.

begin;

alter table if exists public.properties
  add column if not exists seller_contact_id uuid null references public.crm_contacts(id) on delete set null,
  add column if not exists tenant_contact_id uuid null references public.crm_contacts(id) on delete set null;

create index if not exists properties_workspace_seller_contact_idx
  on public.properties (workspace_id, seller_contact_id);

create index if not exists properties_workspace_tenant_contact_idx
  on public.properties (workspace_id, tenant_contact_id);

commit;