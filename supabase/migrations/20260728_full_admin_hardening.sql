-- Full admin hardening pass:
-- - Multi-workspace membership model
-- - Strict workspace read policy
-- - Soft delete lifecycle + purge RPC
-- - Audit snapshots + audit query RPC
-- - Rate limiting + idempotency for destructive actions

begin;

create extension if not exists pgcrypto;

-- =====================================================
-- 1) Membership model
-- =====================================================
create table if not exists public.workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_memberships_role_check check (role in ('super_admin', 'owner', 'team_lead', 'agent')),
  constraint workspace_memberships_status_check check (status in ('active', 'inactive')),
  constraint workspace_memberships_unique_user_workspace unique (user_id, workspace_id)
);

create index if not exists idx_workspace_memberships_user_status
on public.workspace_memberships (user_id, status);

create index if not exists idx_workspace_memberships_workspace_status
on public.workspace_memberships (workspace_id, status);

insert into public.workspace_memberships (user_id, workspace_id, role, status)
select p.id, p.workspace_id, p.role, 'active'
from public.profiles p
where p.workspace_id is not null
on conflict (user_id, workspace_id) do update
set role = excluded.role,
    status = 'active',
    updated_at = now();

create or replace function public.sync_profile_membership()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.workspace_id is not null then
    insert into public.workspace_memberships (user_id, workspace_id, role, status)
    values (new.id, new.workspace_id, new.role, 'active')
    on conflict (user_id, workspace_id) do update
    set role = excluded.role,
        status = 'active',
        updated_at = now();
  end if;

  if tg_op = 'UPDATE' and old.workspace_id is not null and old.workspace_id <> new.workspace_id then
    update public.workspace_memberships
    set status = 'inactive',
        updated_at = now()
    where user_id = old.id
      and workspace_id = old.workspace_id;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_sync_membership on public.profiles;
create trigger profiles_sync_membership
after insert or update of workspace_id, role on public.profiles
for each row
execute function public.sync_profile_membership();

-- =====================================================
-- 2) Soft delete lifecycle for workspaces
-- =====================================================
alter table if exists public.workspaces
add column if not exists deleted_at timestamptz,
add column if not exists deleted_by uuid references public.profiles(id) on delete set null;

create index if not exists idx_workspaces_deleted_at on public.workspaces(deleted_at);

-- =====================================================
-- 3) Audit log snapshots + helper
-- =====================================================
alter table if exists public.audit_logs
add column if not exists workspace_id_snapshot uuid,
add column if not exists actor_email_snapshot text,
add column if not exists actor_role_snapshot text,
add column if not exists source text not null default 'rpc';

create index if not exists idx_audit_logs_workspace_snapshot_created
on public.audit_logs(workspace_id_snapshot, created_at desc);

create or replace function public.write_audit_log(
  p_action text,
  p_workspace_id uuid default null,
  p_company_id uuid default null,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_source text default 'rpc'
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_email text;
  v_actor_role text;
begin
  if p_action is null or trim(p_action) = '' then
    return;
  end if;

  select lower(trim(u.email))
  into v_actor_email
  from auth.users u
  where u.id = auth.uid()
  limit 1;

  select p.role
  into v_actor_role
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  insert into public.audit_logs (
    actor_id,
    action,
    workspace_id,
    workspace_id_snapshot,
    company_id,
    target_type,
    target_id,
    metadata,
    actor_email_snapshot,
    actor_role_snapshot,
    source
  )
  values (
    auth.uid(),
    p_action,
    p_workspace_id,
    p_workspace_id,
    p_company_id,
    p_target_type,
    p_target_id,
    coalesce(p_metadata, '{}'::jsonb),
    v_actor_email,
    v_actor_role,
    coalesce(nullif(trim(p_source), ''), 'rpc')
  );
end;
$$;

-- =====================================================
-- 4) Rate limiting + idempotency
-- =====================================================
create table if not exists public.admin_action_rate_limits (
  actor_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  window_started_at timestamptz not null,
  count integer not null default 0,
  primary key (actor_id, action)
);

create table if not exists public.admin_action_idempotency (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete cascade,
  action text not null,
  idem_key text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  unique (actor_id, action, idem_key)
);

create or replace function public.enforce_rate_limit(
  p_action text,
  p_max integer,
  p_window_seconds integer default 60
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor_id uuid := auth.uid();
  v_now timestamptz := now();
  v_row public.admin_action_rate_limits;
begin
  if v_actor_id is null then
    raise exception 'No authenticated user found';
  end if;

  if p_action is null or trim(p_action) = '' then
    raise exception 'Rate limit action is required';
  end if;

  if p_max is null or p_max <= 0 then
    return;
  end if;

  select *
  into v_row
  from public.admin_action_rate_limits r
  where r.actor_id = v_actor_id
    and r.action = p_action
  limit 1;

  if v_row.actor_id is null then
    insert into public.admin_action_rate_limits (actor_id, action, window_started_at, count)
    values (v_actor_id, p_action, v_now, 1);
    return;
  end if;

  if extract(epoch from (v_now - v_row.window_started_at)) >= p_window_seconds then
    update public.admin_action_rate_limits
    set window_started_at = v_now,
        count = 1
    where actor_id = v_actor_id
      and action = p_action;
    return;
  end if;

  if v_row.count >= p_max then
    raise exception 'Rate limit exceeded for action %', p_action;
  end if;

  update public.admin_action_rate_limits
  set count = count + 1
  where actor_id = v_actor_id
    and action = p_action;
end;
$$;

-- =====================================================
-- 5) Permission helpers
-- =====================================================
create or replace function public.resolve_workspace_role(
  p_workspace_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_current_company_id uuid;
  v_target_company_id uuid;
  v_membership_role text;
begin
  if p_workspace_id is null then
    return null;
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    return null;
  end if;

  if v_profile.role = 'super_admin' then
    return 'super_admin';
  end if;

  select m.role
  into v_membership_role
  from public.workspace_memberships m
  where m.user_id = v_profile.id
    and m.workspace_id = p_workspace_id
    and m.status = 'active'
  limit 1;

  if v_membership_role is not null then
    return v_membership_role;
  end if;

  if v_profile.role = 'owner' then
    select w.company_id into v_current_company_id from public.workspaces w where w.id = v_profile.workspace_id limit 1;
    select w.company_id into v_target_company_id from public.workspaces w where w.id = p_workspace_id limit 1;

    if v_current_company_id is not null and v_target_company_id is not null and v_current_company_id = v_target_company_id then
      return 'owner';
    end if;
  end if;

  if v_profile.workspace_id = p_workspace_id then
    return v_profile.role;
  end if;

  return null;
end;
$$;

create or replace function public.can_access_workspace(
  p_workspace_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role text;
  v_is_deleted boolean;
begin
  if p_workspace_id is null then
    return false;
  end if;

  select (w.deleted_at is not null)
  into v_is_deleted
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if coalesce(v_is_deleted, false) then
    return false;
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);
  return v_role is not null;
end;
$$;

-- =====================================================
-- 6) Tightened workspace SELECT policy
-- =====================================================
drop policy if exists "workspaces_select" on public.workspaces;
create policy "workspaces_select"
on public.workspaces
for select
to authenticated
using (
  workspaces.deleted_at is null
  and (
    public.can_access_workspace(workspaces.id)
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'super_admin'
    )
  )
);

-- =====================================================
-- 7) Access and admin listing RPCs
-- =====================================================
create or replace function public.get_accessible_workspaces()
returns table (
  workspace_id uuid,
  workspace_name text,
  company_id uuid,
  company_name text,
  user_role text,
  is_current boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_current_company_id uuid;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    return;
  end if;

  if v_profile.role = 'super_admin' then
    return query
    select
      w.id,
      w.name,
      w.company_id,
      c.name,
      'super_admin'::text,
      (w.id = v_profile.workspace_id)
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
    where w.deleted_at is null
    order by lower(coalesce(c.name, '')), lower(coalesce(w.name, ''));
    return;
  end if;

  if v_profile.role = 'owner' then
    select w.company_id
    into v_current_company_id
    from public.workspaces w
    where w.id = v_profile.workspace_id
    limit 1;

    if v_current_company_id is null then
      return;
    end if;

    return query
    select
      w.id,
      w.name,
      w.company_id,
      c.name,
      'owner'::text,
      (w.id = v_profile.workspace_id)
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
    where w.deleted_at is null
      and w.company_id = v_current_company_id
    order by lower(coalesce(w.name, ''));
    return;
  end if;

  return query
  select distinct on (w.id)
    w.id,
    w.name,
    w.company_id,
    c.name,
    coalesce(m.role, v_profile.role) as user_role,
    (w.id = v_profile.workspace_id)
  from public.workspaces w
  left join public.companies c on c.id = w.company_id
  left join public.workspace_memberships m
    on m.workspace_id = w.id
   and m.user_id = v_profile.id
   and m.status = 'active'
  where w.deleted_at is null
    and (w.id = v_profile.workspace_id or m.user_id is not null)
  order by w.id, (w.id = v_profile.workspace_id) desc;
end;
$$;

grant execute on function public.get_accessible_workspaces() to authenticated;

create or replace function public.get_admin_workspaces()
returns table (
  workspace_id uuid,
  workspace_name text,
  currency text,
  metric_system text,
  company_id uuid,
  company_name text,
  members_count bigint,
  is_current boolean
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_current_company_id uuid;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    return;
  end if;

  if v_profile.role = 'super_admin' then
    return query
    select
      w.id,
      w.name,
      w.currency,
      w.metric_system,
      w.company_id,
      c.name,
      (
        select count(*)
        from public.workspace_memberships m
        where m.workspace_id = w.id
          and m.status = 'active'
      ) as members_count,
      (w.id = v_profile.workspace_id)
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
    where w.deleted_at is null
    order by lower(coalesce(c.name, '')), lower(coalesce(w.name, ''));
    return;
  end if;

  if v_profile.role = 'owner' then
    select w.company_id
    into v_current_company_id
    from public.workspaces w
    where w.id = v_profile.workspace_id
    limit 1;

    if v_current_company_id is null then
      return;
    end if;

    return query
    select
      w.id,
      w.name,
      w.currency,
      w.metric_system,
      w.company_id,
      c.name,
      (
        select count(*)
        from public.workspace_memberships m
        where m.workspace_id = w.id
          and m.status = 'active'
      ) as members_count,
      (w.id = v_profile.workspace_id)
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
    where w.deleted_at is null
      and w.company_id = v_current_company_id
    order by lower(coalesce(w.name, ''));
    return;
  end if;

  raise exception 'Only super admins and owners can access admin workspaces';
end;
$$;

grant execute on function public.get_admin_workspaces() to authenticated;

-- =====================================================
-- 8) Sensitive action RPCs with safeguards
-- =====================================================
create or replace function public.create_workspace(
  p_name text,
  p_currency text default null,
  p_metric_system text default null,
  p_idempotency_key text default null,
  p_source text default 'admin_page'
)
returns public.workspaces
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_workspace public.workspaces;
  v_company_id uuid;
  v_trimmed_name text;
  v_currency text;
  v_metric_system text;
  v_existing_response jsonb;
  v_existing_workspace_id uuid;
begin
  perform public.enforce_rate_limit('create_workspace', 25, 3600);

  v_trimmed_name := nullif(trim(p_name), '');
  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'EUR'));
  v_metric_system := lower(coalesce(nullif(trim(p_metric_system), ''), 'metric'));

  if v_trimmed_name is null then
    raise exception 'Workspace name is required';
  end if;

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    select i.response
    into v_existing_response
    from public.admin_action_idempotency i
    where i.actor_id = auth.uid()
      and i.action = 'create_workspace'
      and i.idem_key = trim(p_idempotency_key)
    limit 1;

    if v_existing_response is not null then
      v_existing_workspace_id := (v_existing_response ->> 'workspace_id')::uuid;
      select * into v_workspace from public.workspaces w where w.id = v_existing_workspace_id limit 1;
      if v_workspace.id is not null then
        return v_workspace;
      end if;
    end if;
  end if;

  if v_currency not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if v_metric_system not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  select * into v_profile from public.profiles p where p.id = auth.uid() limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can create workspaces';
  end if;

  if v_profile.workspace_id is not null then
    select w.company_id into v_company_id from public.workspaces w where w.id = v_profile.workspace_id limit 1;
  end if;

  if v_profile.role = 'owner' and v_company_id is null then
    raise exception 'Owner workspace must be linked to a company before creating workspaces';
  end if;

  insert into public.workspaces (name, currency, metric_system, company_id)
  values (v_trimmed_name, v_currency, v_metric_system, v_company_id)
  returning * into v_workspace;

  insert into public.workspace_memberships (user_id, workspace_id, role, status)
  values (v_profile.id, v_workspace.id, v_profile.role, 'active')
  on conflict (user_id, workspace_id) do update
  set role = excluded.role,
      status = 'active',
      updated_at = now();

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    insert into public.admin_action_idempotency (actor_id, action, idem_key, response)
    values (
      auth.uid(),
      'create_workspace',
      trim(p_idempotency_key),
      jsonb_build_object('workspace_id', v_workspace.id)
    )
    on conflict (actor_id, action, idem_key) do nothing;
  end if;

  perform public.write_audit_log(
    p_action => 'workspace_created',
    p_workspace_id => v_workspace.id,
    p_company_id => v_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => v_workspace.id::text,
    p_metadata => jsonb_build_object(
      'workspace_name', v_workspace.name,
      'currency', v_workspace.currency,
      'metric_system', v_workspace.metric_system
    ),
    p_source => p_source
  );

  return v_workspace;
end;
$$;

grant execute on function public.create_workspace(text, text, text, text, text) to authenticated;

create or replace function public.switch_workspace(
  p_workspace_id uuid
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_target_workspace public.workspaces;
  v_previous_workspace_id uuid;
begin
  perform public.enforce_rate_limit('switch_workspace', 120, 3600);

  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  select * into v_profile from public.profiles p where p.id = auth.uid() limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  select *
  into v_target_workspace
  from public.workspaces w
  where w.id = p_workspace_id
    and w.deleted_at is null
  limit 1;

  if v_target_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if not public.can_access_workspace(p_workspace_id) then
    raise exception 'You cannot switch to this workspace';
  end if;

  v_previous_workspace_id := v_profile.workspace_id;

  update public.profiles
  set workspace_id = p_workspace_id
  where id = auth.uid();

  perform public.write_audit_log(
    p_action => 'workspace_switched',
    p_workspace_id => p_workspace_id,
    p_company_id => v_target_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => p_workspace_id::text,
    p_metadata => jsonb_build_object(
      'from_workspace_id', v_previous_workspace_id,
      'to_workspace_name', v_target_workspace.name
    ),
    p_source => 'workspace_switcher'
  );

  return json_build_object(
    'workspace_id', v_target_workspace.id,
    'workspace_name', v_target_workspace.name,
    'company_id', v_target_workspace.company_id
  );
end;
$$;

grant execute on function public.switch_workspace(uuid) to authenticated;

create or replace function public.update_workspace_settings(
  p_workspace_id uuid,
  p_name text default null,
  p_currency text default null,
  p_metric_system text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace public.workspaces;
  v_role text;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  select *
  into v_workspace
  from public.workspaces w
  where w.id = p_workspace_id
    and w.deleted_at is null
  limit 1;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role is null then
    raise exception 'You do not have access to this workspace';
  end if;

  if v_role not in ('super_admin', 'owner', 'team_lead') then
    raise exception 'Only super admins, owners, and team leads can change workspace settings';
  end if;

  if p_currency is not null and p_currency not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if p_metric_system is not null and p_metric_system not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  update public.workspaces
  set
    name = coalesce(p_name, name),
    currency = coalesce(p_currency, currency),
    metric_system = coalesce(p_metric_system, metric_system)
  where id = p_workspace_id
  returning * into v_workspace;

  return v_workspace;
end;
$$;

grant execute on function public.update_workspace_settings(uuid, text, text, text) to authenticated;

create or replace function public.update_company_settings(
  p_workspace_id uuid,
  p_company_name text
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role text;
  v_company_id uuid;
  v_company public.companies;
  v_trimmed_name text;
begin
  v_trimmed_name := nullif(trim(p_company_name), '');

  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  if v_trimmed_name is null then
    raise exception 'Company name is required';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can change company settings';
  end if;

  select w.company_id
  into v_company_id
  from public.workspaces w
  where w.id = p_workspace_id
    and w.deleted_at is null
  limit 1;

  if v_company_id is null then
    insert into public.companies (name)
    values (v_trimmed_name)
    returning * into v_company;

    update public.workspaces
    set company_id = v_company.id
    where id = p_workspace_id;
  else
    update public.companies
    set
      name = v_trimmed_name,
      updated_at = now()
    where id = v_company_id
    returning * into v_company;
  end if;

  perform public.write_audit_log(
    p_action => 'company_settings_updated',
    p_workspace_id => p_workspace_id,
    p_company_id => v_company.id,
    p_target_type => 'company',
    p_target_id => v_company.id::text,
    p_metadata => jsonb_build_object('company_name', v_company.name),
    p_source => 'admin_page'
  );

  return json_build_object(
    'workspace_id', p_workspace_id,
    'company_id', v_company.id,
    'company_name', v_company.name
  );
end;
$$;

grant execute on function public.update_company_settings(uuid, text) to authenticated;

create or replace function public.create_workspace_invite(
  p_workspace_id uuid,
  p_email text,
  p_role text default 'agent',
  p_invited_by uuid default null
)
returns public.workspace_invites
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_invite public.workspace_invites;
  v_role text := lower(coalesce(p_role, 'agent'));
  v_inviter_role text;
  v_target_company_id uuid;
begin
  perform public.enforce_rate_limit('create_workspace_invite', 60, 3600);

  if v_role = 'agency_lead' then
    v_role := 'team_lead';
  end if;

  if v_role not in ('super_admin', 'owner', 'team_lead', 'agent') then
    v_role := 'agent';
  end if;

  if p_email is null or trim(p_email) = '' then
    raise exception 'Email is required';
  end if;

  if p_workspace_id is null then
    raise exception 'A workspace is required';
  end if;

  select w.company_id
  into v_target_company_id
  from public.workspaces w
  where w.id = p_workspace_id
    and w.deleted_at is null
  limit 1;

  if v_target_company_id is null then
    raise exception 'Workspace not found';
  end if;

  v_inviter_role := public.resolve_workspace_role(p_workspace_id);

  if v_inviter_role is null then
    raise exception 'You do not have access to this workspace';
  end if;

  if v_inviter_role = 'super_admin' then
    null;
  elsif v_inviter_role = 'owner' and v_role in ('owner', 'team_lead', 'agent') then
    null;
  elsif v_inviter_role = 'team_lead' and v_role in ('team_lead', 'agent') then
    null;
  else
    raise exception 'You are not allowed to assign that role';
  end if;

  insert into public.workspace_invites (
    workspace_id,
    invited_by,
    email,
    role,
    token,
    status,
    expires_at
  )
  values (
    p_workspace_id,
    coalesce(p_invited_by, auth.uid()),
    lower(trim(p_email)),
    v_role,
    public.generate_invite_token(),
    'pending',
    now() + interval '7 days'
  )
  returning * into v_invite;

  perform public.write_audit_log(
    p_action => 'workspace_invite_created',
    p_workspace_id => p_workspace_id,
    p_company_id => v_target_company_id,
    p_target_type => 'workspace_invite',
    p_target_id => v_invite.id::text,
    p_metadata => jsonb_build_object(
      'invite_email', v_invite.email,
      'invite_role', v_invite.role
    ),
    p_source => 'settings_page'
  );

  return v_invite;
end;
$$;

grant execute on function public.create_workspace_invite(uuid, text, text, uuid) to authenticated;

create or replace function public.delete_workspace(
  p_workspace_id uuid,
  p_confirm_workspace_name text default null,
  p_idempotency_key text default null,
  p_source text default 'admin_page'
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role text;
  v_target_workspace public.workspaces;
  v_assigned_members_count bigint;
  v_existing_response jsonb;
begin
  perform public.enforce_rate_limit('delete_workspace', 20, 3600);

  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    select i.response
    into v_existing_response
    from public.admin_action_idempotency i
    where i.actor_id = auth.uid()
      and i.action = 'delete_workspace'
      and i.idem_key = trim(p_idempotency_key)
    limit 1;

    if v_existing_response is not null then
      return v_existing_response;
    end if;
  end if;

  select *
  into v_target_workspace
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if v_target_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_target_workspace.deleted_at is not null then
    raise exception 'Workspace is already archived';
  end if;

  if p_confirm_workspace_name is not null and trim(p_confirm_workspace_name) <> trim(v_target_workspace.name) then
    raise exception 'Workspace confirmation name does not match';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can delete workspaces';
  end if;

  if exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = p_workspace_id
  ) then
    raise exception 'You cannot delete your current workspace';
  end if;

  select count(*)
  into v_assigned_members_count
  from public.workspace_memberships m
  where m.workspace_id = p_workspace_id
    and m.status = 'active';

  if v_assigned_members_count > 0 then
    raise exception 'Cannot delete a workspace with assigned members';
  end if;

  update public.workspaces
  set
    deleted_at = now(),
    deleted_by = auth.uid()
  where id = p_workspace_id;

  update public.workspace_memberships
  set
    status = 'inactive',
    updated_at = now()
  where workspace_id = p_workspace_id
    and status = 'active';

  perform public.write_audit_log(
    p_action => 'workspace_deleted',
    p_workspace_id => null,
    p_company_id => v_target_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => p_workspace_id::text,
    p_metadata => jsonb_build_object(
      'workspace_name', v_target_workspace.name,
      'deleted_workspace_id', p_workspace_id,
      'deletion_mode', 'soft'
    ),
    p_source => p_source
  );

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    insert into public.admin_action_idempotency (actor_id, action, idem_key, response)
    values (
      auth.uid(),
      'delete_workspace',
      trim(p_idempotency_key),
      jsonb_build_object(
        'workspace_id', p_workspace_id,
        'status', 'archived'
      )
    )
    on conflict (actor_id, action, idem_key) do nothing;
  end if;

  return json_build_object(
    'workspace_id', p_workspace_id,
    'status', 'archived'
  );
end;
$$;

grant execute on function public.delete_workspace(uuid, text, text, text) to authenticated;

create or replace function public.purge_deleted_workspace(
  p_workspace_id uuid
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_target_workspace public.workspaces;
  v_memberships_count bigint;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  select * into v_profile from public.profiles p where p.id = auth.uid() limit 1;

  if v_profile.role <> 'super_admin' then
    raise exception 'Only super admins can purge archived workspaces';
  end if;

  select *
  into v_target_workspace
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if v_target_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_target_workspace.deleted_at is null then
    raise exception 'Workspace must be archived first';
  end if;

  if v_target_workspace.deleted_at > now() - interval '24 hours' then
    raise exception 'Workspace can only be purged after 24 hours';
  end if;

  select count(*)
  into v_memberships_count
  from public.workspace_memberships m
  where m.workspace_id = p_workspace_id
    and m.status = 'active';

  if v_memberships_count > 0 then
    raise exception 'Cannot purge workspace with active members';
  end if;

  delete from public.workspaces
  where id = p_workspace_id;

  perform public.write_audit_log(
    p_action => 'workspace_purged',
    p_workspace_id => null,
    p_company_id => v_target_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => p_workspace_id::text,
    p_metadata => jsonb_build_object(
      'workspace_name', v_target_workspace.name,
      'deleted_workspace_id', p_workspace_id,
      'deletion_mode', 'hard'
    ),
    p_source => 'admin_page'
  );

  return json_build_object(
    'workspace_id', p_workspace_id,
    'status', 'purged'
  );
end;
$$;

grant execute on function public.purge_deleted_workspace(uuid) to authenticated;

-- =====================================================
-- 9) Audit logs query RPC
-- =====================================================
create or replace function public.get_audit_logs(
  p_limit integer default 100,
  p_action text default null,
  p_workspace_id uuid default null
)
returns table (
  id uuid,
  actor_id uuid,
  actor_email_snapshot text,
  actor_role_snapshot text,
  action text,
  workspace_id uuid,
  workspace_id_snapshot uuid,
  company_id uuid,
  target_type text,
  target_id text,
  source text,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_current_company_id uuid;
  v_limit integer;
begin
  v_limit := greatest(1, least(coalesce(p_limit, 100), 500));

  select * into v_profile from public.profiles p where p.id = auth.uid() limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.role = 'super_admin' then
    return query
    select
      l.id,
      l.actor_id,
      l.actor_email_snapshot,
      l.actor_role_snapshot,
      l.action,
      l.workspace_id,
      l.workspace_id_snapshot,
      l.company_id,
      l.target_type,
      l.target_id,
      l.source,
      l.metadata,
      l.created_at
    from public.audit_logs l
    where (p_action is null or l.action = p_action)
      and (p_workspace_id is null or l.workspace_id_snapshot = p_workspace_id or l.workspace_id = p_workspace_id)
    order by l.created_at desc
    limit v_limit;
    return;
  end if;

  if v_profile.role <> 'owner' then
    raise exception 'Only super admins and owners can access audit logs';
  end if;

  select w.company_id
  into v_current_company_id
  from public.workspaces w
  where w.id = v_profile.workspace_id
  limit 1;

  if v_current_company_id is null then
    return;
  end if;

  return query
  select
    l.id,
    l.actor_id,
    l.actor_email_snapshot,
    l.actor_role_snapshot,
    l.action,
    l.workspace_id,
    l.workspace_id_snapshot,
    l.company_id,
    l.target_type,
    l.target_id,
    l.source,
    l.metadata,
    l.created_at
  from public.audit_logs l
  where l.company_id = v_current_company_id
    and (p_action is null or l.action = p_action)
    and (p_workspace_id is null or l.workspace_id_snapshot = p_workspace_id or l.workspace_id = p_workspace_id)
  order by l.created_at desc
  limit v_limit;
end;
$$;

grant execute on function public.get_audit_logs(integer, text, uuid) to authenticated;

commit;
