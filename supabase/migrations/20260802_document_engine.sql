-- Document engine foundation for France Tier 1 legal workflows.

begin;

create table if not exists public.workspace_branding (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  agency_name text not null,
  logo_url text,
  primary_color text not null default '#0F172A',
  accent_color text not null default '#3B82F6',
  carte_t_number text not null,
  carte_t_cci text not null,
  siret text not null,
  rcp_policy_number text not null,
  rcp_insurer text not null,
  guarantor_name text not null,
  guarantor_amount_eur numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_branding_primary_color_check check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint workspace_branding_accent_color_check check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  constraint workspace_branding_guarantor_amount_check check (guarantor_amount_eur >= 0)
);

create table if not exists public.workspace_custom_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  document_type text not null,
  country_code text not null default 'FR',
  name text not null,
  docx_file_url text not null,
  detected_placeholders jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint workspace_custom_templates_document_type_check check (document_type in ('mandat_vente', 'mandat_recherche', 'bail_location', 'avenant')),
  constraint workspace_custom_templates_country_code_check check (country_code ~ '^[A-Z]{2}$')
);

create table if not exists public.workspace_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid null references public.crm_contacts(id) on delete set null,
  property_id uuid null references public.properties(id) on delete set null,
  template_source text not null,
  custom_template_id uuid null references public.workspace_custom_templates(id) on delete set null,
  type text not null,
  country_code text not null default 'FR',
  jurisdiction text not null default 'france',
  parent_document_id uuid null references public.workspace_documents(id) on delete set null,
  mandate_number integer null,
  title text not null,
  form_data jsonb not null default '{}'::jsonb,
  special_clauses text[] not null default '{}',
  file_url text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_documents_template_source_check check (template_source in ('versaline_standard', 'agency_custom')),
  constraint workspace_documents_type_check check (type in ('mandat_vente', 'mandat_recherche', 'bail_location', 'avenant')),
  constraint workspace_documents_status_check check (status in ('draft', 'finalized', 'signed')),
  constraint workspace_documents_country_code_check check (country_code ~ '^[A-Z]{2}$')
);

create table if not exists public.workspace_mandate_counters (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  last_number integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint workspace_mandate_counters_last_number_check check (last_number >= 0)
);

create index if not exists workspace_custom_templates_workspace_idx
  on public.workspace_custom_templates (workspace_id, document_type, created_at desc);

create index if not exists workspace_documents_workspace_created_idx
  on public.workspace_documents (workspace_id, created_at desc);

create index if not exists workspace_documents_workspace_type_idx
  on public.workspace_documents (workspace_id, type, created_at desc);

create index if not exists workspace_documents_workspace_status_idx
  on public.workspace_documents (workspace_id, status, updated_at desc);

create index if not exists workspace_documents_contact_idx
  on public.workspace_documents (workspace_id, contact_id);

create index if not exists workspace_documents_property_idx
  on public.workspace_documents (workspace_id, property_id);

create index if not exists workspace_documents_custom_template_idx
  on public.workspace_documents (workspace_id, custom_template_id);

alter table public.workspace_branding enable row level security;
alter table public.workspace_custom_templates enable row level security;
alter table public.workspace_documents enable row level security;
alter table public.workspace_mandate_counters enable row level security;

drop policy if exists "workspace_branding_select" on public.workspace_branding;
create policy "workspace_branding_select"
on public.workspace_branding
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "workspace_branding_insert" on public.workspace_branding;
create policy "workspace_branding_insert"
on public.workspace_branding
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "workspace_branding_update" on public.workspace_branding;
create policy "workspace_branding_update"
on public.workspace_branding
for update
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "workspace_custom_templates_select" on public.workspace_custom_templates;
create policy "workspace_custom_templates_select"
on public.workspace_custom_templates
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "workspace_custom_templates_insert" on public.workspace_custom_templates;
create policy "workspace_custom_templates_insert"
on public.workspace_custom_templates
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "workspace_custom_templates_update" on public.workspace_custom_templates;
create policy "workspace_custom_templates_update"
on public.workspace_custom_templates
for update
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "workspace_custom_templates_delete" on public.workspace_custom_templates;
create policy "workspace_custom_templates_delete"
on public.workspace_custom_templates
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "workspace_documents_select" on public.workspace_documents;
create policy "workspace_documents_select"
on public.workspace_documents
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "workspace_documents_insert" on public.workspace_documents;
create policy "workspace_documents_insert"
on public.workspace_documents
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "workspace_documents_update" on public.workspace_documents;
create policy "workspace_documents_update"
on public.workspace_documents
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

drop policy if exists "workspace_documents_delete" on public.workspace_documents;
create policy "workspace_documents_delete"
on public.workspace_documents
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "workspace_mandate_counters_select" on public.workspace_mandate_counters;
create policy "workspace_mandate_counters_select"
on public.workspace_mandate_counters
for select
to authenticated
using (public.can_access_workspace(workspace_id));

grant select, insert, update, delete on table public.workspace_branding to authenticated;
grant select, insert, update, delete on table public.workspace_custom_templates to authenticated;
grant select, insert, update, delete on table public.workspace_documents to authenticated;
grant select on table public.workspace_mandate_counters to authenticated;

create or replace function public.set_updated_at_workspace_branding()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_workspace_branding on public.workspace_branding;
create trigger trg_set_updated_at_workspace_branding
before update on public.workspace_branding
for each row
execute function public.set_updated_at_workspace_branding();

create or replace function public.set_updated_at_workspace_documents()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_workspace_documents on public.workspace_documents;
create trigger trg_set_updated_at_workspace_documents
before update on public.workspace_documents
for each row
execute function public.set_updated_at_workspace_documents();

create or replace function public.set_workspace_document_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if new.workspace_id is null and v_profile.workspace_id is not null then
    new.workspace_id := v_profile.workspace_id;
  end if;

  if new.workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  if new.custom_template_id is not null and not exists (
    select 1
    from public.workspace_custom_templates t
    where t.id = new.custom_template_id
      and t.workspace_id = new.workspace_id
  ) then
    raise exception 'Custom template must belong to the same workspace';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_workspace_documents_defaults on public.workspace_documents;
create trigger trg_workspace_documents_defaults
before insert on public.workspace_documents
for each row
execute function public.set_workspace_document_defaults();

create or replace function public.get_next_mandate_number(
  p_workspace_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role text;
  v_next_number integer;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role is null then
    raise exception 'You do not have access to this workspace';
  end if;

  if v_role not in ('super_admin', 'owner', 'team_lead', 'agent') then
    raise exception 'You do not have permission to allocate mandate numbers';
  end if;

  insert into public.workspace_mandate_counters as counters (
    workspace_id,
    last_number,
    updated_at
  )
  values (
    p_workspace_id,
    1,
    now()
  )
  on conflict (workspace_id)
  do update
    set last_number = counters.last_number + 1,
        updated_at = now()
  returning counters.last_number into v_next_number;

  return v_next_number;
end;
$$;

grant execute on function public.get_next_mandate_number(uuid) to authenticated;

insert into storage.buckets (id, name, public)
values ('agency-templates', 'agency-templates', false)
on conflict (id) do nothing;

drop policy if exists "agency_templates_select" on storage.objects;
create policy "agency_templates_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'agency-templates'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "agency_templates_insert" on storage.objects;
create policy "agency_templates_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'agency-templates'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "agency_templates_update" on storage.objects;
create policy "agency_templates_update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'agency-templates'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead')
)
with check (
  bucket_id = 'agency-templates'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "agency_templates_delete" on storage.objects;
create policy "agency_templates_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'agency-templates'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead')
);

commit;