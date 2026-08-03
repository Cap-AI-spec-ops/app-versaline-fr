-- Hard fix for recursion on email_ingestion_policies writes/selects.
-- This avoids policy loops by using security-definer helpers with row_security disabled.

begin;

create or replace function public.current_user_platform_role()
returns text
language sql
security definer
set search_path = public, auth
set row_security = off
stable
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
  limit 1
$$;

create or replace function public.current_user_company_id()
returns uuid
language sql
security definer
set search_path = public, auth
set row_security = off
stable
as $$
  select w.company_id
  from public.profiles p
  join public.workspaces w on w.id = p.workspace_id
  where p.id = auth.uid()
  limit 1
$$;

create or replace function public.email_ingestion_policies_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_actor_id uuid := auth.uid();
  v_profile public.profiles;
  v_current_workspace public.workspaces;
  v_target_workspace public.workspaces;
begin
  if v_actor_id is null then
    if new.company_id is null and new.workspace_id is not null then
      select *
      into v_target_workspace
      from public.workspaces w
      where w.id = new.workspace_id
      limit 1;

      if v_target_workspace.id is null then
        raise exception 'Target workspace not found';
      end if;

      new.company_id := v_target_workspace.company_id;
    end if;

    if new.company_id is null then
      raise exception 'Company scope is required for policy';
    end if;

    return new;
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = v_actor_id
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.workspace_id is null then
    raise exception 'No active workspace on profile';
  end if;

  select *
  into v_current_workspace
  from public.workspaces w
  where w.id = v_profile.workspace_id
  limit 1;

  if v_current_workspace.id is null then
    raise exception 'Current workspace not found';
  end if;

  if new.company_id is null then
    if new.workspace_id is not null then
      select *
      into v_target_workspace
      from public.workspaces w
      where w.id = new.workspace_id
      limit 1;

      if v_target_workspace.id is null then
        raise exception 'Target workspace not found';
      end if;

      new.company_id := v_target_workspace.company_id;
    else
      new.company_id := v_current_workspace.company_id;
    end if;
  end if;

  if new.company_id is null then
    raise exception 'Company scope is required for policy';
  end if;

  if new.workspace_id is null then
    new.workspace_id := v_current_workspace.id;
  end if;

  if v_profile.role = 'super_admin' then
    null;
  elsif v_profile.role = 'owner' then
    if v_current_workspace.company_id is null or v_current_workspace.company_id <> new.company_id then
      raise exception 'Owners can only edit policies for their own company';
    end if;
  else
    raise exception 'Only super admins and owners can update email policy';
  end if;

  if tg_op = 'INSERT' and new.created_by is null then
    new.created_by := v_profile.id;
  end if;

  new.updated_by := v_profile.id;

  return new;
end;
$$;

drop trigger if exists trg_email_ingestion_policies_defaults on public.email_ingestion_policies;
create trigger trg_email_ingestion_policies_defaults
before insert or update on public.email_ingestion_policies
for each row
execute function public.email_ingestion_policies_defaults();

drop policy if exists "email_ingestion_policies_select" on public.email_ingestion_policies;
create policy "email_ingestion_policies_select"
on public.email_ingestion_policies
for select
to authenticated
using (
  public.current_user_platform_role() = 'super_admin'
  or public.current_user_company_id() = company_id
);

drop policy if exists "email_ingestion_policies_insert" on public.email_ingestion_policies;
create policy "email_ingestion_policies_insert"
on public.email_ingestion_policies
for insert
to authenticated
with check (
  public.current_user_platform_role() = 'super_admin'
  or (
    public.current_user_platform_role() = 'owner'
    and public.current_user_company_id() = company_id
  )
);

drop policy if exists "email_ingestion_policies_update" on public.email_ingestion_policies;
create policy "email_ingestion_policies_update"
on public.email_ingestion_policies
for update
to authenticated
using (
  public.current_user_platform_role() = 'super_admin'
  or (
    public.current_user_platform_role() = 'owner'
    and public.current_user_company_id() = company_id
  )
)
with check (
  public.current_user_platform_role() = 'super_admin'
  or (
    public.current_user_platform_role() = 'owner'
    and public.current_user_company_id() = company_id
  )
);

drop policy if exists "email_ingestion_policies_delete" on public.email_ingestion_policies;
create policy "email_ingestion_policies_delete"
on public.email_ingestion_policies
for delete
to authenticated
using (
  public.current_user_platform_role() = 'super_admin'
  or (
    public.current_user_platform_role() = 'owner'
    and public.current_user_company_id() = company_id
  )
);

commit;
