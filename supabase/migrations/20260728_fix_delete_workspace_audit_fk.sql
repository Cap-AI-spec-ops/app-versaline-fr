-- Fix delete_workspace audit logging FK issue
-- When a workspace is deleted, audit log must not insert a workspace_id
-- that no longer exists.

begin;

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
    p_workspace_id => null,
    p_company_id => v_target_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => p_workspace_id::text,
    p_metadata => jsonb_build_object(
      'workspace_name', v_target_workspace.name,
      'deleted_workspace_id', p_workspace_id
    )
  );

  return json_build_object(
    'workspace_id', p_workspace_id,
    'status', 'deleted'
  );
end;
$$;

commit;
