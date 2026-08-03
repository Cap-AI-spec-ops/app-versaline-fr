-- Multi-assignee support for CRM contacts (workspace-scoped)

begin;

create table if not exists public.crm_contact_assignees (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  assigned_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint crm_contact_assignees_unique unique (contact_id, profile_id)
);

create index if not exists crm_contact_assignees_workspace_idx
  on public.crm_contact_assignees (workspace_id, contact_id);

create index if not exists crm_contact_assignees_profile_idx
  on public.crm_contact_assignees (profile_id);

alter table public.crm_contact_assignees enable row level security;

drop policy if exists "crm_contact_assignees_select" on public.crm_contact_assignees;
create policy "crm_contact_assignees_select"
on public.crm_contact_assignees
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "crm_contact_assignees_insert" on public.crm_contact_assignees;
create policy "crm_contact_assignees_insert"
on public.crm_contact_assignees
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "crm_contact_assignees_delete" on public.crm_contact_assignees;
create policy "crm_contact_assignees_delete"
on public.crm_contact_assignees
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

create or replace function public.crm_contact_assignees_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_contact public.crm_contacts;
  v_profile public.profiles;
begin
  select *
  into v_contact
  from public.crm_contacts c
  where c.id = new.contact_id
  limit 1;

  if v_contact.id is null then
    raise exception 'Contact not found';
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if new.workspace_id is null then
    new.workspace_id := v_contact.workspace_id;
  end if;

  if new.workspace_id <> v_contact.workspace_id then
    raise exception 'Assignee workspace must match contact workspace';
  end if;

  if new.assigned_by is null and v_profile.id is not null then
    new.assigned_by := v_profile.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_crm_contact_assignees_defaults on public.crm_contact_assignees;
create trigger trg_crm_contact_assignees_defaults
before insert on public.crm_contact_assignees
for each row
execute function public.crm_contact_assignees_defaults();

create or replace function public.crm_assign_creator_on_contact_insert()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_assignee_id uuid;
begin
  v_assignee_id := coalesce(new.created_by, auth.uid());

  if v_assignee_id is not null then
    insert into public.crm_contact_assignees (
      workspace_id,
      contact_id,
      profile_id,
      assigned_by
    ) values (
      new.workspace_id,
      new.id,
      v_assignee_id,
      v_assignee_id
    )
    on conflict (contact_id, profile_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_crm_assign_creator_on_contact_insert on public.crm_contacts;
create trigger trg_crm_assign_creator_on_contact_insert
after insert on public.crm_contacts
for each row
execute function public.crm_assign_creator_on_contact_insert();

grant select, insert, delete on table public.crm_contact_assignees to authenticated;

commit;
