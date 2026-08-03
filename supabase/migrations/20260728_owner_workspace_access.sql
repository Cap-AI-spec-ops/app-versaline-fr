-- Owner workspace switching and cross-workspace access within the same company

begin;

-- =====================================================
-- 1) List accessible workspaces for the authenticated user
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
      w.id as workspace_id,
      w.name as workspace_name,
      w.company_id,
      c.name as company_name,
      v_profile.role as user_role,
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
      return query
      select
        w.id as workspace_id,
        w.name as workspace_name,
        w.company_id,
        c.name as company_name,
        v_profile.role as user_role,
        (w.id = v_profile.workspace_id) as is_current
      from public.workspaces w
      left join public.companies c on c.id = w.company_id
      where w.id = v_profile.workspace_id;

      return;
    end if;

    return query
    select
      w.id as workspace_id,
      w.name as workspace_name,
      w.company_id,
      c.name as company_name,
      v_profile.role as user_role,
      (w.id = v_profile.workspace_id) as is_current
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
    where w.company_id = v_current_company_id
    order by lower(coalesce(w.name, ''));

    return;
  end if;

  return query
  select
    w.id as workspace_id,
    w.name as workspace_name,
    w.company_id,
    c.name as company_name,
    v_profile.role as user_role,
    true as is_current
  from public.workspaces w
  left join public.companies c on c.id = w.company_id
  where w.id = v_profile.workspace_id
  limit 1;
end;
$$;

grant execute on function public.get_accessible_workspaces() to authenticated;

-- =====================================================
-- 2) Switch current workspace
-- =====================================================
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

  return json_build_object(
    'workspace_id', v_target_workspace.id,
    'workspace_name', v_target_workspace.name,
    'company_id', v_target_workspace.company_id
  );
end;
$$;

grant execute on function public.switch_workspace(uuid) to authenticated;

-- =====================================================
-- 3) Cross-workspace permissions for owners (same company)
-- =====================================================
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
  v_profile public.profiles;
  v_current_company_id uuid;
  v_target_company_id uuid;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.role not in ('super_admin', 'owner', 'team_lead') then
    raise exception 'Only super admins, owners, and team leads can change workspace settings';
  end if;

  if v_profile.role = 'team_lead' and v_profile.workspace_id <> p_workspace_id then
    raise exception 'Team leads can only manage their own workspace';
  end if;

  if v_profile.role = 'owner' then
    select company_id into v_current_company_id from public.workspaces where id = v_profile.workspace_id limit 1;
    select company_id into v_target_company_id from public.workspaces where id = p_workspace_id limit 1;

    if v_current_company_id is null or v_target_company_id is null or v_current_company_id <> v_target_company_id then
      raise exception 'Owners can only manage workspaces inside their company';
    end if;
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

  if v_workspace is null then
    raise exception 'Workspace not found';
  end if;

  return v_workspace;
end;
$$;

drop policy if exists "workspaces_update" on public.workspaces;
create policy "workspaces_update"
on public.workspaces
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.role = 'super_admin'
        or (p.role = 'team_lead' and p.workspace_id = workspaces.id)
        or (
          p.role = 'owner'
          and exists (
            select 1
            from public.workspaces current_w
            where current_w.id = p.workspace_id
              and current_w.company_id is not null
              and current_w.company_id = workspaces.company_id
          )
        )
      )
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        p.role = 'super_admin'
        or (p.role = 'team_lead' and p.workspace_id = workspaces.id)
        or (
          p.role = 'owner'
          and exists (
            select 1
            from public.workspaces current_w
            where current_w.id = p.workspace_id
              and current_w.company_id is not null
              and current_w.company_id = workspaces.company_id
          )
        )
      )
  )
);

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
    select company_id into v_target_company_id from public.workspaces where id = p_workspace_id limit 1;

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

  return v_invite;
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

  return json_build_object(
    'workspace_id', p_workspace_id,
    'company_id', v_company.id,
    'company_name', v_company.name
  );
end;
$$;

commit;
