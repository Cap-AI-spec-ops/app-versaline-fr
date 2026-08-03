-- Restrict workspace switching to super_admin and owner roles

begin;

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
    and w.deleted_at is null
  limit 1;

  if v_target_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_profile.role not in ('super_admin', 'owner') and p_workspace_id <> v_profile.workspace_id then
    raise exception 'Only super admins and owners can switch workspaces';
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

commit;
