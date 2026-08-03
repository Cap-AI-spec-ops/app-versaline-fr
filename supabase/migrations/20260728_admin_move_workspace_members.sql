begin;

create or replace function public.get_admin_workspace_members()
returns table (
  profile_id uuid,
  first_name text,
  last_name text,
  role text,
  workspace_id uuid,
  workspace_name text,
  company_id uuid,
  company_name text
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

  if v_profile.role = 'owner' then
    select w.company_id
    into v_current_company_id
    from public.workspaces w
    where w.id = v_profile.workspace_id
    limit 1;

    if v_current_company_id is null then
      return;
    end if;
  elsif v_profile.role <> 'super_admin' then
    raise exception 'Only super admins and owners can access admin members';
  end if;

  return query
  select
    p.id as profile_id,
    nullif(trim(u.raw_user_meta_data ->> 'first_name'), '') as first_name,
    nullif(trim(u.raw_user_meta_data ->> 'last_name'), '') as last_name,
    p.role,
    w.id as workspace_id,
    w.name as workspace_name,
    w.company_id,
    c.name as company_name
  from public.profiles p
  join public.workspaces w on w.id = p.workspace_id
  left join public.companies c on c.id = w.company_id
  left join auth.users u on u.id = p.id
  where w.deleted_at is null
    and (
      v_profile.role = 'super_admin'
      or w.company_id = v_current_company_id
    )
  order by
    lower(coalesce(w.name, '')),
    case p.role
      when 'super_admin' then 1
      when 'owner' then 2
      when 'team_lead' then 3
      else 4
    end,
    lower(coalesce(u.raw_user_meta_data ->> 'last_name', '')),
    lower(coalesce(u.raw_user_meta_data ->> 'first_name', '')),
    p.id::text;
end;
$$;

grant execute on function public.get_admin_workspace_members() to authenticated;

create or replace function public.move_workspace_member(
  p_profile_id uuid,
  p_target_workspace_id uuid,
  p_idempotency_key text default null,
  p_source text default 'admin_page'
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_actor public.profiles;
  v_target_profile public.profiles;
  v_source_workspace public.workspaces;
  v_target_workspace public.workspaces;
  v_actor_company_id uuid;
  v_existing_response jsonb;
begin
  perform public.enforce_rate_limit('move_workspace_member', 60, 3600);

  if p_profile_id is null then
    raise exception 'Member is required';
  end if;

  if p_target_workspace_id is null then
    raise exception 'Target workspace is required';
  end if;

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    select i.response
    into v_existing_response
    from public.admin_action_idempotency i
    where i.actor_id = auth.uid()
      and i.action = 'move_workspace_member'
      and i.idem_key = trim(p_idempotency_key)
    limit 1;

    if v_existing_response is not null then
      return v_existing_response;
    end if;
  end if;

  select * into v_actor from public.profiles p where p.id = auth.uid() limit 1;

  if v_actor.id is null then
    raise exception 'Profile not found';
  end if;

  if v_actor.role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can move coworkers';
  end if;

  if v_actor.id = p_profile_id then
    raise exception 'You cannot move your own account';
  end if;

  select * into v_target_profile from public.profiles p where p.id = p_profile_id limit 1;

  if v_target_profile.id is null then
    raise exception 'Member not found';
  end if;

  if v_target_profile.workspace_id is null then
    raise exception 'Member does not have a current workspace';
  end if;

  select * into v_source_workspace from public.workspaces w where w.id = v_target_profile.workspace_id and w.deleted_at is null limit 1;
  select * into v_target_workspace from public.workspaces w where w.id = p_target_workspace_id and w.deleted_at is null limit 1;

  if v_source_workspace.id is null then
    raise exception 'Source workspace not found';
  end if;

  if v_target_workspace.id is null then
    raise exception 'Target workspace not found';
  end if;

  if v_target_profile.workspace_id = p_target_workspace_id then
    raise exception 'Member is already in that workspace';
  end if;

  if v_actor.role = 'owner' then
    select w.company_id into v_actor_company_id from public.workspaces w where w.id = v_actor.workspace_id limit 1;

    if v_actor_company_id is null then
      raise exception 'Owner workspace must be linked to a company';
    end if;

    if v_source_workspace.company_id is distinct from v_actor_company_id
       or v_target_workspace.company_id is distinct from v_actor_company_id then
      raise exception 'Owners can only move coworkers inside their company';
    end if;

    if v_target_profile.role = 'super_admin' then
      raise exception 'Owners cannot move super admins';
    end if;
  end if;

  update public.workspace_memberships
  set status = 'inactive',
      updated_at = now()
  where user_id = p_profile_id
    and workspace_id = v_source_workspace.id
    and status = 'active';

  insert into public.workspace_memberships (user_id, workspace_id, role, status)
  values (p_profile_id, p_target_workspace_id, v_target_profile.role, 'active')
  on conflict (user_id, workspace_id) do update
  set role = excluded.role,
      status = 'active',
      updated_at = now();

  update public.profiles
  set workspace_id = p_target_workspace_id
  where id = p_profile_id;

  perform public.write_audit_log(
    p_action => 'workspace_member_moved',
    p_workspace_id => p_target_workspace_id,
    p_company_id => v_target_workspace.company_id,
    p_target_type => 'profile',
    p_target_id => p_profile_id::text,
    p_metadata => jsonb_build_object(
      'profile_id', p_profile_id,
      'member_role', v_target_profile.role,
      'from_workspace_id', v_source_workspace.id,
      'from_workspace_name', v_source_workspace.name,
      'to_workspace_id', v_target_workspace.id,
      'to_workspace_name', v_target_workspace.name
    ),
    p_source => p_source
  );

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    insert into public.admin_action_idempotency (actor_id, action, idem_key, response)
    values (
      auth.uid(),
      'move_workspace_member',
      trim(p_idempotency_key),
      jsonb_build_object(
        'profile_id', p_profile_id,
        'workspace_id', p_target_workspace_id,
        'status', 'moved'
      )
    )
    on conflict (actor_id, action, idem_key) do nothing;
  end if;

  return json_build_object(
    'profile_id', p_profile_id,
    'workspace_id', p_target_workspace_id,
    'status', 'moved'
  );
end;
$$;

grant execute on function public.move_workspace_member(uuid, uuid, text, text) to authenticated;

commit;