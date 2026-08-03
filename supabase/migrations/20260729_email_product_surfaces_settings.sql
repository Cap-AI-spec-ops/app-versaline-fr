-- Phase 4 + 6 support tables for mailbox settings and workspace email policy

begin;

create table if not exists public.mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  status text not null default 'disconnected',
  include_sent_mail boolean not null default false,
  summary_language text not null default 'en',
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mailbox_connections_provider_check check (provider in ('gmail', 'outlook')),
  constraint mailbox_connections_status_check check (status in ('connected', 'disconnected', 'pending', 'error')),
  constraint mailbox_connections_summary_language_not_empty check (length(trim(summary_language)) > 0),
  constraint mailbox_connections_unique_profile_workspace_provider unique (workspace_id, profile_id, provider)
);

create index if not exists mailbox_connections_workspace_profile_idx
  on public.mailbox_connections (workspace_id, profile_id);

create table if not exists public.email_ingestion_policies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  feature_enabled boolean not null default false,
  summary_retention_days integer not null default 180,
  confidence_threshold integer not null default 70,
  unknown_sender_behavior text not null default 'discard',
  created_by uuid null references public.profiles(id) on delete set null,
  updated_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_ingestion_policies_workspace_unique unique (workspace_id),
  constraint email_ingestion_policies_retention_days_check check (summary_retention_days between 30 and 365),
  constraint email_ingestion_policies_confidence_threshold_check check (confidence_threshold between 0 and 100),
  constraint email_ingestion_policies_unknown_sender_behavior_check check (
    unknown_sender_behavior in ('discard', 'keep', 'create_minimal_lead_shell')
  )
);

create or replace function public.set_updated_at_mailbox_connections()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_mailbox_connections on public.mailbox_connections;
create trigger trg_set_updated_at_mailbox_connections
before update on public.mailbox_connections
for each row
execute function public.set_updated_at_mailbox_connections();

create or replace function public.set_updated_at_email_ingestion_policies()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_email_ingestion_policies on public.email_ingestion_policies;
create trigger trg_set_updated_at_email_ingestion_policies
before update on public.email_ingestion_policies
for each row
execute function public.set_updated_at_email_ingestion_policies();

create or replace function public.mailbox_connections_defaults()
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
    raise exception 'Profile not found';
  end if;

  if new.profile_id is null then
    new.profile_id := v_profile.id;
  end if;

  if new.profile_id <> v_profile.id then
    raise exception 'You can only modify your own mailbox connection';
  end if;

  if new.workspace_id is null then
    new.workspace_id := v_profile.workspace_id;
  end if;

  if not public.can_access_workspace(new.workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  new.provider := lower(trim(new.provider));
  new.summary_language := lower(trim(new.summary_language));

  return new;
end;
$$;

drop trigger if exists trg_mailbox_connections_defaults on public.mailbox_connections;
create trigger trg_mailbox_connections_defaults
before insert or update on public.mailbox_connections
for each row
execute function public.mailbox_connections_defaults();

create or replace function public.email_ingestion_policies_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_role text;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if new.workspace_id is null then
    new.workspace_id := v_profile.workspace_id;
  end if;

  if not public.can_access_workspace(new.workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  v_role := public.resolve_workspace_role(new.workspace_id);

  if v_role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can update email policy';
  end if;

  if tg_op = 'INSERT' and new.created_by is null then
    new.created_by := v_profile.id;
  end if;

  new.updated_by := v_profile.id;

  return new;
end;
$$;

drop trigger if exists trg_email_ingestion_policies_defaults on public.email_ingestion_policies;
create trigger trg_email_ingestion_policies_defaults
before insert or update on public.email_ingestion_policies
for each row
execute function public.email_ingestion_policies_defaults();

alter table public.mailbox_connections enable row level security;
alter table public.email_ingestion_policies enable row level security;

drop policy if exists "mailbox_connections_select" on public.mailbox_connections;
create policy "mailbox_connections_select"
on public.mailbox_connections
for select
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "mailbox_connections_insert" on public.mailbox_connections;
create policy "mailbox_connections_insert"
on public.mailbox_connections
for insert
to authenticated
with check (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "mailbox_connections_update" on public.mailbox_connections;
create policy "mailbox_connections_update"
on public.mailbox_connections
for update
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
)
with check (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "mailbox_connections_delete" on public.mailbox_connections;
create policy "mailbox_connections_delete"
on public.mailbox_connections
for delete
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "email_ingestion_policies_select" on public.email_ingestion_policies;
create policy "email_ingestion_policies_select"
on public.email_ingestion_policies
for select
to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "email_ingestion_policies_insert" on public.email_ingestion_policies;
create policy "email_ingestion_policies_insert"
on public.email_ingestion_policies
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "email_ingestion_policies_update" on public.email_ingestion_policies;
create policy "email_ingestion_policies_update"
on public.email_ingestion_policies
for update
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "email_ingestion_policies_delete" on public.email_ingestion_policies;
create policy "email_ingestion_policies_delete"
on public.email_ingestion_policies
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

grant select, insert, update, delete on table public.mailbox_connections to authenticated;
grant select, insert, update, delete on table public.email_ingestion_policies to authenticated;

commit;
