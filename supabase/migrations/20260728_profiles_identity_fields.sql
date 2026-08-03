begin;

alter table public.profiles
add column if not exists first_name text,
add column if not exists last_name text,
add column if not exists email text;

create index if not exists idx_profiles_email on public.profiles (email);

update public.profiles p
set
  first_name = nullif(trim(u.raw_user_meta_data ->> 'first_name'), ''),
  last_name = nullif(trim(u.raw_user_meta_data ->> 'last_name'), ''),
  email = lower(trim(u.email))
from auth.users u
where u.id = p.id;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace_id uuid;
  v_role text;
begin
  v_role := coalesce(new.raw_user_meta_data ->> 'role', 'agent');

  if v_role = 'agency_lead' then
    v_role := 'team_lead';
  end if;

  if v_role not in ('super_admin', 'owner', 'team_lead', 'agent') then
    v_role := 'agent';
  end if;

  if new.raw_user_meta_data ? 'workspace_id' then
    begin
      v_workspace_id := (new.raw_user_meta_data ->> 'workspace_id')::uuid;
    exception when invalid_text_representation then
      v_workspace_id := null;
    end;
  end if;

  insert into public.profiles (id, workspace_id, role, first_name, last_name, email)
  values (
    new.id,
    v_workspace_id,
    v_role,
    nullif(trim(new.raw_user_meta_data ->> 'first_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'last_name'), ''),
    lower(trim(new.email))
  )
  on conflict (id) do update
  set workspace_id = coalesce(excluded.workspace_id, public.profiles.workspace_id),
      role = excluded.role,
      first_name = coalesce(excluded.first_name, public.profiles.first_name),
      last_name = coalesce(excluded.last_name, public.profiles.last_name),
      email = coalesce(excluded.email, public.profiles.email);

  return new;
end;
$$;

create or replace function public.sync_profile_email_from_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  update public.profiles
  set email = lower(trim(new.email))
  where id = new.id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
after update of email on auth.users
for each row
execute function public.sync_profile_email_from_auth_user();

create or replace function public.update_current_profile_identity(
  p_first_name text default null,
  p_last_name text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
begin
  update public.profiles
  set
    first_name = nullif(trim(p_first_name), ''),
    last_name = nullif(trim(p_last_name), '')
  where id = auth.uid()
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  return v_profile;
end;
$$;

grant execute on function public.update_current_profile_identity(text, text) to authenticated;

create or replace function public.get_workspace_members()
returns table (
  profile_id uuid,
  first_name text,
  last_name text,
  role text,
  joined_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace_id uuid;
begin
  select p.workspace_id
  into v_workspace_id
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_workspace_id is null then
    return;
  end if;

  return query
  select
    p.id as profile_id,
    p.first_name,
    p.last_name,
    p.role,
    u.created_at as joined_at
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.workspace_id = v_workspace_id
  order by
    case p.role
      when 'super_admin' then 1
      when 'owner' then 2
      when 'team_lead' then 3
      else 4
    end,
    lower(coalesce(p.last_name, '')),
    lower(coalesce(p.first_name, '')),
    p.id::text;
end;
$$;

grant execute on function public.get_workspace_members() to authenticated;

drop function if exists public.get_admin_workspace_members();

create or replace function public.get_admin_workspace_members()
returns table (
  profile_id uuid,
  first_name text,
  last_name text,
  email text,
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
    p.first_name,
    p.last_name,
    p.email,
    p.role,
    w.id as workspace_id,
    w.name as workspace_name,
    w.company_id,
    c.name as company_name
  from public.profiles p
  join public.workspaces w on w.id = p.workspace_id
  left join public.companies c on c.id = w.company_id
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
    lower(coalesce(p.last_name, '')),
    lower(coalesce(p.first_name, '')),
    p.id::text;
end;
$$;

grant execute on function public.get_admin_workspace_members() to authenticated;

commit;