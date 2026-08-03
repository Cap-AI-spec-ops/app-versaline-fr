-- Credit balance read RPC for client UI components under strict RLS

begin;

create or replace function public.get_workspace_credit_balance(
  p_workspace_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_workspace_id uuid;
  v_workspace public.workspaces;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  v_workspace_id := coalesce(p_workspace_id, v_profile.workspace_id);

  if v_workspace_id is null then
    raise exception 'No workspace selected';
  end if;

  if not (
    public.can_access_workspace(v_workspace_id)
    or v_profile.role = 'super_admin'
  ) then
    raise exception 'You do not have access to this workspace';
  end if;

  select *
  into v_workspace
  from public.workspaces w
  where w.id = v_workspace_id
  limit 1;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_workspace.deleted_at is not null then
    raise exception 'Workspace is archived';
  end if;

  return jsonb_build_object(
    'workspace_id', v_workspace.id,
    'credit_balance', coalesce(v_workspace.credit_balance, 0)
  );
end;
$$;

grant execute on function public.get_workspace_credit_balance(uuid) to authenticated;

commit;
