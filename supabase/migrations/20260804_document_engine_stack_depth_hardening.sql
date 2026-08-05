-- Harden document/workspace helper RPCs against recursive RLS stack depth failures.

begin;

create or replace function public.get_current_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_profile public.profiles;
begin
  select *
  into v_profile
  from public.profiles
  where id = auth.uid()
  limit 1;

  return v_profile;
end;
$$;

create or replace function public.get_current_workspace()
returns public.workspaces
language plpgsql
security definer
set search_path = public, auth
set row_security = off
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

create or replace function public.set_workspace_document_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_profile public.profiles;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if new.workspace_id is null and v_profile.workspace_id is not null then
    new.workspace_id := v_profile.workspace_id;
  end if;

  if new.workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  if new.custom_template_id is not null and not exists (
    select 1
    from public.workspace_custom_templates t
    where t.id = new.custom_template_id
      and t.workspace_id = new.workspace_id
  ) then
    raise exception 'Custom template must belong to the same workspace';
  end if;

  return new;
end;
$$;

create or replace function public.get_next_mandate_number(
  p_workspace_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, auth
set row_security = off
as $$
declare
  v_role text;
  v_next_number integer;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role is null then
    raise exception 'You do not have access to this workspace';
  end if;

  if v_role not in ('super_admin', 'owner', 'team_lead', 'agent') then
    raise exception 'You do not have permission to allocate mandate numbers';
  end if;

  insert into public.workspace_mandate_counters as counters (
    workspace_id,
    last_number,
    updated_at
  )
  values (
    p_workspace_id,
    1,
    now()
  )
  on conflict (workspace_id)
  do update
    set last_number = counters.last_number + 1,
        updated_at = now()
  returning counters.last_number into v_next_number;

  return v_next_number;
end;
$$;

commit;