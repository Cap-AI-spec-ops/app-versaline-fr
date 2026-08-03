-- CRM contacts + interaction timeline (workspace-scoped)

begin;

create table if not exists public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid null references public.profiles(id) on delete set null,
  assigned_to uuid null references public.profiles(id) on delete set null,
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  address text,
  budget numeric(12, 2),
  currency text not null default 'EUR',
  client_type text not null default 'buyer',
  stage text not null default 'new_lead',
  priority text not null default 'normal',
  source text,
  preferred_channel text not null default 'phone',
  notes text,
  next_follow_up_at timestamptz,
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contacts_client_type_check check (client_type in ('buyer', 'seller', 'tenant', 'landlord', 'investor', 'vendor', 'other')),
  constraint crm_contacts_stage_check check (stage in ('new_lead', 'qualified', 'viewing', 'negotiating', 'closed_won', 'closed_lost')),
  constraint crm_contacts_priority_check check (priority in ('low', 'normal', 'high')),
  constraint crm_contacts_preferred_channel_check check (preferred_channel in ('phone', 'email', 'whatsapp', 'sms', 'other')),
  constraint crm_contacts_budget_check check (budget is null or budget >= 0)
);

create table if not exists public.crm_contact_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  created_by uuid null references public.profiles(id) on delete set null,
  event_type text not null,
  title text not null,
  body text,
  metadata jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint crm_contact_events_event_type_check check (event_type in ('note', 'call', 'email', 'meeting', 'status_change', 'created'))
);

create index if not exists crm_contacts_workspace_idx on public.crm_contacts(workspace_id);
create index if not exists crm_contacts_stage_idx on public.crm_contacts(workspace_id, stage);
create index if not exists crm_contacts_updated_at_idx on public.crm_contacts(workspace_id, updated_at desc);
create index if not exists crm_contact_events_workspace_contact_idx on public.crm_contact_events(workspace_id, contact_id, occurred_at desc);

alter table public.crm_contacts enable row level security;
alter table public.crm_contact_events enable row level security;

drop policy if exists "crm_contacts_select" on public.crm_contacts;
create policy "crm_contacts_select"
on public.crm_contacts
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "crm_contacts_insert" on public.crm_contacts;
create policy "crm_contacts_insert"
on public.crm_contacts
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "crm_contacts_update" on public.crm_contacts;
create policy "crm_contacts_update"
on public.crm_contacts
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

drop policy if exists "crm_contacts_delete" on public.crm_contacts;
create policy "crm_contacts_delete"
on public.crm_contacts
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "crm_contact_events_select" on public.crm_contact_events;
create policy "crm_contact_events_select"
on public.crm_contact_events
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "crm_contact_events_insert" on public.crm_contact_events;
create policy "crm_contact_events_insert"
on public.crm_contact_events
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "crm_contact_events_update" on public.crm_contact_events;
create policy "crm_contact_events_update"
on public.crm_contact_events
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

drop policy if exists "crm_contact_events_delete" on public.crm_contact_events;
create policy "crm_contact_events_delete"
on public.crm_contact_events
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

create or replace function public.set_updated_at_crm_contacts()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_crm_contacts on public.crm_contacts;
create trigger trg_set_updated_at_crm_contacts
before update on public.crm_contacts
for each row
execute function public.set_updated_at_crm_contacts();

create or replace function public.crm_set_created_by_defaults()
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

  if v_profile.id is null then
    return new;
  end if;

  if new.created_by is null then
    new.created_by := v_profile.id;
  end if;

  if new.workspace_id is null then
    new.workspace_id := v_profile.workspace_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_crm_contacts_defaults on public.crm_contacts;
create trigger trg_crm_contacts_defaults
before insert on public.crm_contacts
for each row
execute function public.crm_set_created_by_defaults();

create or replace function public.crm_contact_events_defaults()
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
    raise exception 'Event workspace must match contact workspace';
  end if;

  if new.created_by is null and v_profile.id is not null then
    new.created_by := v_profile.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_crm_contact_events_defaults on public.crm_contact_events;
create trigger trg_crm_contact_events_defaults
before insert on public.crm_contact_events
for each row
execute function public.crm_contact_events_defaults();

create or replace function public.crm_log_contact_system_events()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.crm_contact_events (
      workspace_id,
      contact_id,
      created_by,
      event_type,
      title,
      body,
      metadata,
      occurred_at
    ) values (
      new.workspace_id,
      new.id,
      new.created_by,
      'created',
      'Contact created',
      format('%s %s entered the CRM as %s', new.first_name, new.last_name, new.client_type),
      jsonb_build_object('stage', new.stage, 'priority', new.priority),
      now()
    );
  elsif tg_op = 'UPDATE' and new.stage is distinct from old.stage then
    insert into public.crm_contact_events (
      workspace_id,
      contact_id,
      created_by,
      event_type,
      title,
      body,
      metadata,
      occurred_at
    ) values (
      new.workspace_id,
      new.id,
      auth.uid(),
      'status_change',
      'Stage updated',
      format('Moved from %s to %s', old.stage, new.stage),
      jsonb_build_object('from_stage', old.stage, 'to_stage', new.stage),
      now()
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_crm_log_contact_system_events on public.crm_contacts;
create trigger trg_crm_log_contact_system_events
after insert or update on public.crm_contacts
for each row
execute function public.crm_log_contact_system_events();

commit;
