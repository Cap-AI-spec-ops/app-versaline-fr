-- Secure helper to load the authenticated user's current workspace

begin;

create or replace function public.get_current_workspace()
returns public.workspaces
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace public.workspaces;
begin
  select w.*
  into v_workspace
  from public.profiles p
  join public.workspaces w on w.id = p.workspace_id
  where p.id = auth.uid()
  limit 1;

  return v_workspace;
end;
$$;

commit;
