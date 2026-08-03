-- Prevent RLS recursion loops that can surface as "stack depth limit exceeded".

begin;

create or replace function public.resolve_workspace_role(
  p_workspace_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, auth
set row_security = off
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
set row_security = off
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

-- Keep workspace listing aligned with access helper while avoiding recursive policy logic.
drop policy if exists "workspaces_select" on public.workspaces;
create policy "workspaces_select"
on public.workspaces
for select
to authenticated
using (
  workspaces.deleted_at is null
  and public.can_access_workspace(workspaces.id)
);

commit;
