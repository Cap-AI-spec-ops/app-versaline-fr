-- Add company model and new role hierarchy: super_admin > owner > team_lead > agent

begin;

-- =====================================================
-- 1) Companies + workspace.company_id
-- =====================================================
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.workspaces
add column if not exists company_id uuid references public.companies(id) on delete set null;

create index if not exists idx_workspaces_company_id on public.workspaces(company_id);

-- =====================================================
-- 2) Role migration: agency_lead -> team_lead, add owner
-- =====================================================
-- Drop existing profile role checks dynamically so role remapping can run safely.
do $$
declare
  v_constraint_name text;
begin
  for v_constraint_name in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'profiles'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint if exists %I', v_constraint_name);
  end loop;
end;
$$;

alter table if exists public.workspace_invites
drop constraint if exists workspace_invites_role_check;

update public.profiles
set role = 'team_lead'
where role = 'agency_lead';

update public.workspace_invites
set role = 'team_lead'
where role = 'agency_lead';

do $$
begin
  alter table public.profiles
  add constraint profiles_role_check check (role in ('super_admin', 'owner', 'team_lead', 'agent'));
exception when duplicate_object then
  null;
end $$;

do $$
begin
  alter table public.workspace_invites
  add constraint workspace_invites_role_check check (role in ('super_admin', 'owner', 'team_lead', 'agent'));
exception when duplicate_object then
  null;
end $$;

-- =====================================================
-- 3) Invite RPC with new hierarchy
-- =====================================================
create or replace function public.create_workspace_invite(
  p_workspace_id uuid,
  p_email text,
  p_role text default 'agent',
  p_invited_by uuid default null
)
returns public.workspace_invites
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_invite public.workspace_invites;
  v_role text := lower(coalesce(p_role, 'agent'));
  v_inviter_role text;
  v_inviter_workspace_id uuid;
begin
  if v_role = 'agency_lead' then
    v_role := 'team_lead';
  end if;

  if v_role not in ('super_admin', 'owner', 'team_lead', 'agent') then
    v_role := 'agent';
  end if;

  if p_email is null or trim(p_email) = '' then
    raise exception 'Email is required';
  end if;

  select p.role, p.workspace_id
  into v_inviter_role, v_inviter_workspace_id
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_inviter_role is null then
    raise exception 'You need a profile before inviting teammates';
  end if;

  if p_workspace_id is null then
    raise exception 'A workspace is required';
  end if;

  if v_inviter_workspace_id is null or p_workspace_id <> v_inviter_workspace_id then
    raise exception 'You can only invite teammates into your own workspace';
  end if;

  if v_inviter_role = 'super_admin' then
    null;
  elsif v_inviter_role = 'owner' and v_role in ('owner', 'team_lead', 'agent') then
    null;
  elsif v_inviter_role = 'team_lead' and v_role in ('team_lead', 'agent') then
    null;
  else
    raise exception 'You are not allowed to assign that role';
  end if;

  insert into public.workspace_invites (
    workspace_id,
    invited_by,
    email,
    role,
    token,
    status,
    expires_at
  )
  values (
    p_workspace_id,
    coalesce(p_invited_by, auth.uid()),
    lower(trim(p_email)),
    v_role,
    public.generate_invite_token(),
    'pending',
    now() + interval '7 days'
  )
  returning * into v_invite;

  return v_invite;
end;
$$;

-- =====================================================
-- 4) Workspace settings RPC + UPDATE policy with owner/team_lead
-- =====================================================
create or replace function public.update_workspace_settings(
  p_workspace_id uuid,
  p_name text default null,
  p_currency text default null,
  p_metric_system text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace public.workspaces;
  v_user_role text;
begin
  select role
  into v_user_role
  from public.profiles
  where id = auth.uid()
    and workspace_id = p_workspace_id
  limit 1;

  if v_user_role is null then
    raise exception 'You do not have access to this workspace';
  end if;

  if v_user_role not in ('super_admin', 'owner', 'team_lead') then
    raise exception 'Only super admins, owners, and team leads can change workspace settings';
  end if;

  if p_currency is not null and p_currency not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if p_metric_system is not null and p_metric_system not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  update public.workspaces
  set
    name = coalesce(p_name, name),
    currency = coalesce(p_currency, currency),
    metric_system = coalesce(p_metric_system, metric_system)
  where id = p_workspace_id
  returning * into v_workspace;

  if v_workspace is null then
    raise exception 'Workspace not found';
  end if;

  return v_workspace;
end;
$$;

drop policy if exists "workspaces_update" on public.workspaces;
create policy "workspaces_update"
on public.workspaces
for update
to authenticated
using (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.workspace_id = workspaces.id
      and profiles.role in ('super_admin', 'owner', 'team_lead')
  )
)
with check (
  exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.workspace_id = workspaces.id
      and profiles.role in ('super_admin', 'owner', 'team_lead')
  )
);

-- =====================================================
-- 5) Company settings RPC (super_admin + owner)
-- =====================================================
create or replace function public.update_company_settings(
  p_workspace_id uuid,
  p_company_name text
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_role text;
  v_company_id uuid;
  v_company public.companies;
  v_trimmed_name text;
begin
  v_trimmed_name := nullif(trim(p_company_name), '');

  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  if v_trimmed_name is null then
    raise exception 'Company name is required';
  end if;

  select p.role
  into v_user_role
  from public.profiles p
  where p.id = auth.uid()
    and p.workspace_id = p_workspace_id
  limit 1;

  if v_user_role is null then
    raise exception 'You do not have access to this workspace';
  end if;

  if v_user_role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can change company settings';
  end if;

  select w.company_id
  into v_company_id
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if v_company_id is null then
    insert into public.companies (name)
    values (v_trimmed_name)
    returning * into v_company;

    update public.workspaces
    set company_id = v_company.id
    where id = p_workspace_id;
  else
    update public.companies
    set
      name = v_trimmed_name,
      updated_at = now()
    where id = v_company_id
    returning * into v_company;
  end if;

  return json_build_object(
    'workspace_id', p_workspace_id,
    'company_id', v_company.id,
    'company_name', v_company.name
  );
end;
$$;

-- =====================================================
-- 6) New user profile role normalization
-- =====================================================
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
  v_role := lower(coalesce(new.raw_user_meta_data ->> 'role', 'agent'));

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

  insert into public.profiles (id, workspace_id, role)
  values (new.id, v_workspace_id, v_role)
  on conflict (id) do update
  set workspace_id = coalesce(excluded.workspace_id, public.profiles.workspace_id),
      role = excluded.role;

  return new;
end;
$$;

-- =====================================================
-- 7) Member list ordering with owner/team_lead
-- =====================================================
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
    nullif(trim(u.raw_user_meta_data ->> 'first_name'), '') as first_name,
    nullif(trim(u.raw_user_meta_data ->> 'last_name'), '') as last_name,
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
    lower(coalesce(u.raw_user_meta_data ->> 'last_name', '')),
    lower(coalesce(u.raw_user_meta_data ->> 'first_name', '')),
    p.id::text;
end;
$$;

grant execute on function public.get_workspace_members() to authenticated;

-- =====================================================
-- 8) Company RLS and grants for read access
-- =====================================================
alter table public.companies enable row level security;

drop policy if exists "companies_select_same_workspace" on public.companies;
create policy "companies_select_same_workspace"
on public.companies
for select
to authenticated
using (
  exists (
    select 1
    from public.workspaces w
    join public.profiles p on p.workspace_id = w.id
    where w.company_id = companies.id
      and p.id = auth.uid()
  )
);

drop policy if exists "companies_update_owner" on public.companies;
create policy "companies_update_owner"
on public.companies
for update
to authenticated
using (
  exists (
    select 1
    from public.workspaces w
    join public.profiles p on p.workspace_id = w.id
    where w.company_id = companies.id
      and p.id = auth.uid()
      and p.role in ('super_admin', 'owner')
  )
)
with check (
  exists (
    select 1
    from public.workspaces w
    join public.profiles p on p.workspace_id = w.id
    where w.company_id = companies.id
      and p.id = auth.uid()
      and p.role in ('super_admin', 'owner')
  )
);

grant select, update on table public.companies to authenticated;

commit;
