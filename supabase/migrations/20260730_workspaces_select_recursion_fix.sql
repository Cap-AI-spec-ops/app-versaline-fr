-- Fix RLS recursion in workspaces_select policy that could cause stack depth errors.

begin;

create or replace function public.current_user_company_id()
returns uuid
language plpgsql
security definer
set search_path = public, auth
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

drop policy if exists "workspaces_select" on public.workspaces;
create policy "workspaces_select"
on public.workspaces
for select
to authenticated
using (
  workspaces.deleted_at is null
  and (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'super_admin'
    )
    or exists (
      select 1
      from public.workspace_memberships m
      where m.user_id = auth.uid()
        and m.workspace_id = workspaces.id
        and m.status = 'active'
    )
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.workspace_id = workspaces.id
    )
    or (
      workspaces.company_id is not null
      and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.role = 'owner'
      )
      and workspaces.company_id = public.current_user_company_id()
    )
  )
);

commit;
