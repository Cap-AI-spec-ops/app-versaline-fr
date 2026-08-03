-- Audit logging and admin workspace management RPCs

begin;

create extension if not exists pgcrypto;

-- =====================================================
-- 1) Audit log table + helper
-- =====================================================
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_actor_id_created_at on public.audit_logs(actor_id, created_at desc);
create index if not exists idx_audit_logs_action_created_at on public.audit_logs(action, created_at desc);
create index if not exists idx_audit_logs_workspace_id_created_at on public.audit_logs(workspace_id, created_at desc);
create index if not exists idx_audit_logs_company_id_created_at on public.audit_logs(company_id, created_at desc);

create or replace function public.write_audit_log(
  p_action text,
  p_workspace_id uuid default null,
  p_company_id uuid default null,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if p_action is null or trim(p_action) = '' then
    return;
  end if;

  insert into public.audit_logs (
    actor_id,
    action,
    workspace_id,
    company_id,
    target_type,
    target_id,
    metadata
  )
  values (
    auth.uid(),
    p_action,
    p_workspace_id,
    p_company_id,
    p_target_type,
    p_target_id,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- =====================================================
-- 2) Admin workspace listing
-- =====================================================
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
      w.id as workspace_id,
      w.name as workspace_name,
      w.currency,
      w.metric_system,
      w.company_id,
      c.name as company_name,
      (
        select count(*)
        from public.profiles p
        where p.workspace_id = w.id
      ) as members_count,
      (w.id = v_profile.workspace_id) as is_current
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
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
      w.id as workspace_id,
      w.name as workspace_name,
      w.currency,
      w.metric_system,
      w.company_id,
      c.name as company_name,
      (
        select count(*)
        from public.profiles p
        where p.workspace_id = w.id
      ) as members_count,
      (w.id = v_profile.workspace_id) as is_current
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
    where w.company_id = v_current_company_id
    order by lower(coalesce(w.name, ''));

    return;
  end if;

  raise exception 'Only super admins and owners can access admin workspaces';
end;
$$;

grant execute on function public.get_admin_workspaces() to authenticated;

-- =====================================================
-- 3) Delete workspace (admin)
-- =====================================================
create or replace function public.delete_workspace(
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
  v_current_company_id uuid;
  v_assigned_members_count bigint;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can delete workspaces';
  end if;

  select *
  into v_target_workspace
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if v_target_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_profile.workspace_id = p_workspace_id then
    raise exception 'You cannot delete your current workspace';
  end if;

  if v_profile.role = 'owner' then
    select w.company_id
    into v_current_company_id
    from public.workspaces w
    where w.id = v_profile.workspace_id
    limit 1;

    if v_current_company_id is null or v_target_workspace.company_id is null or v_target_workspace.company_id <> v_current_company_id then
      raise exception 'Owners can only delete workspaces inside their company';
    end if;
  end if;

  select count(*)
  into v_assigned_members_count
  from public.profiles p
  where p.workspace_id = p_workspace_id;

  if v_assigned_members_count > 0 then
    raise exception 'Cannot delete a workspace with assigned members';
  end if;

  delete from public.workspaces
  where id = p_workspace_id;

  perform public.write_audit_log(
    p_action => 'workspace_deleted',
    p_workspace_id => p_workspace_id,
    p_company_id => v_target_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => p_workspace_id::text,
    p_metadata => jsonb_build_object(
      'workspace_name', v_target_workspace.name
    )
  );

  return json_build_object(
    'workspace_id', p_workspace_id,
    'status', 'deleted'
  );
end;
$$;

grant execute on function public.delete_workspace(uuid) to authenticated;

-- =====================================================
-- 4) Add audit events to sensitive RPCs
-- =====================================================
create or replace function public.create_workspace(
  p_name text,
  p_currency text default null,
  p_metric_system text default null
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
begin
  v_trimmed_name := nullif(trim(p_name), '');
  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'EUR'));
  v_metric_system := lower(coalesce(nullif(trim(p_metric_system), ''), 'metric'));

  if v_trimmed_name is null then
    raise exception 'Workspace name is required';
  end if;

  if v_currency not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if v_metric_system not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can create workspaces';
  end if;

  if v_profile.workspace_id is not null then
    select w.company_id
    into v_company_id
    from public.workspaces w
    where w.id = v_profile.workspace_id
    limit 1;
  end if;

  if v_profile.role = 'owner' and v_company_id is null then
    raise exception 'Owner workspace must be linked to a company before creating workspaces';
  end if;

  insert into public.workspaces (
    name,
    currency,
    metric_system,
    company_id
  )
  values (
    v_trimmed_name,
    v_currency,
    v_metric_system,
    v_company_id
  )
  returning * into v_workspace;

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
    )
  );

  return v_workspace;
end;
$$;

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
  v_current_company_id uuid;
  v_target_workspace public.workspaces;
  v_previous_workspace_id uuid;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  v_previous_workspace_id := v_profile.workspace_id;

  select *
  into v_target_workspace
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if v_target_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_profile.role = 'super_admin' then
    null;
  elsif v_profile.role = 'owner' then
    select w.company_id
    into v_current_company_id
    from public.workspaces w
    where w.id = v_profile.workspace_id
    limit 1;

    if v_current_company_id is null then
      raise exception 'Owner workspace is not linked to a company';
    end if;

    if v_target_workspace.company_id is null or v_target_workspace.company_id <> v_current_company_id then
      raise exception 'Owners can only switch within their company workspaces';
    end if;
  elsif v_profile.workspace_id <> p_workspace_id then
    raise exception 'You cannot switch to this workspace';
  end if;

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
    )
  );

  return json_build_object(
    'workspace_id', v_target_workspace.id,
    'workspace_name', v_target_workspace.name,
    'company_id', v_target_workspace.company_id
  );
end;
$$;

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
  v_profile public.profiles;
  v_current_company_id uuid;
  v_target_company_id uuid;
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

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can change company settings';
  end if;

  if v_profile.role = 'owner' then
    select company_id into v_current_company_id from public.workspaces where id = v_profile.workspace_id limit 1;
    select company_id into v_target_company_id from public.workspaces where id = p_workspace_id limit 1;

    if v_current_company_id is null or v_target_company_id is null or v_current_company_id <> v_target_company_id then
      raise exception 'Owners can only manage their own company settings';
    end if;
  end if;

  select w.company_id
  into v_company_id
  from public.workspaces w
  where w.id = p_workspace_id
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
    p_metadata => jsonb_build_object(
      'company_name', v_company.name
    )
  );

  return json_build_object(
    'workspace_id', p_workspace_id,
    'company_id', v_company.id,
    'company_name', v_company.name
  );
end;
$$;

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
  v_profile public.profiles;
  v_current_company_id uuid;
  v_target_company_id uuid;
begin
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
  limit 1;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'You need a profile before inviting teammates';
  end if;

  if v_profile.role = 'super_admin' then
    null;
  elsif v_profile.role = 'owner' then
    select company_id into v_current_company_id from public.workspaces where id = v_profile.workspace_id limit 1;

    if v_current_company_id is null or v_target_company_id is null or v_current_company_id <> v_target_company_id then
      raise exception 'Owners can only invite inside their company workspaces';
    end if;

    if v_role not in ('owner', 'team_lead', 'agent') then
      raise exception 'Owners cannot assign that role';
    end if;
  elsif v_profile.role = 'team_lead' then
    if v_profile.workspace_id <> p_workspace_id then
      raise exception 'Team leads can only invite into their own workspace';
    end if;

    if v_role not in ('team_lead', 'agent') then
      raise exception 'Team leads cannot assign that role';
    end if;
  else
    raise exception 'Only super admins, owners, and team leads can invite teammates';
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
    )
  );

  return v_invite;
end;
$$;

commit;
