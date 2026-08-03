-- Hard-fix workspaces RLS recursion causing stack depth errors in authenticated flows.

begin;

create or replace function public.current_user_company_id()
returns uuid
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_company_id uuid;
begin
  select w.company_id
  into v_company_id
  from public.profiles p
  join public.workspaces w on w.id = p.workspace_id
  where p.id = auth.uid()
  limit 1;

  return v_company_id;
end;
$$;

-- Keep the select policy simple and non-recursive. Access checks are centralized in can_access_workspace.
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
