-- Workspace invitation + membership flow for multi-tenant agencies
-- This adds:
-- 1) workspace_invites table for email-based invitations
-- 2) RPC helpers to create and accept invitations
-- 3) automatic profile creation for new auth users

begin;

create extension if not exists pgcrypto;

-- =====================================================
-- 1) Workspace invitations
-- =====================================================
create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invited_by uuid references public.profiles(id) on delete set null,
  email text not null,
  role text not null default 'agent',
  token text not null unique,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete set null,
  constraint workspace_invites_role_check check (role in ('super_admin', 'agency_lead', 'agent')),
  constraint workspace_invites_status_check check (status in ('pending', 'accepted', 'expired', 'revoked'))
);

create index if not exists idx_workspace_invites_workspace_id on public.workspace_invites(workspace_id);
create index if not exists idx_workspace_invites_email on public.workspace_invites(email);
create index if not exists idx_workspace_invites_status on public.workspace_invites(status);

-- =====================================================
-- 2) Helper to fetch the current user's profile
-- =====================================================
create or replace function public.get_current_profile()
returns public.profiles
language plpgsql
security definer
set search_path = public, auth
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

-- =====================================================
-- 3) Helpers to create a secure invite token
-- =====================================================
create or replace function public.generate_invite_token()
returns text
language sql
as $$
  select md5(random()::text || clock_timestamp()::text || coalesce(auth.uid()::text, 'anon') || random()::text);
$$;

-- =====================================================
-- 4) RPC: create an invitation (used from the app)
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
  if v_role not in ('super_admin', 'agency_lead', 'agent') then
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
  elsif v_inviter_role = 'agency_lead' and v_role in ('agent', 'agency_lead') then
    null;
  elsif v_inviter_role = 'agent' and v_role = 'agent' then
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
-- 5) RPC: accept an invitation by token
-- =====================================================
create or replace function public.accept_workspace_invite(
  p_token text,
  p_user_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_invite public.workspace_invites;
  v_target_user_id uuid;
  v_workspace_id uuid;
  v_role text;
begin
  if p_token is null or trim(p_token) = '' then
    raise exception 'Invite token is required';
  end if;

  select *
  into v_invite
  from public.workspace_invites
  where token = p_token
  limit 1;

  if not found then
    raise exception 'Invite not found';
  end if;

  if v_invite.status = 'accepted' then
    raise exception 'Invite already accepted';
  end if;

  if v_invite.status = 'revoked' then
    raise exception 'Invite has been revoked';
  end if;

  if v_invite.expires_at < now() then
    update public.workspace_invites
    set status = 'expired'
    where id = v_invite.id;

    raise exception 'Invite has expired';
  end if;

  v_target_user_id := coalesce(p_user_id, auth.uid());

  if v_target_user_id is null then
    raise exception 'No authenticated user found';
  end if;

  -- Ensure the profile exists for the user
  insert into public.profiles (id, workspace_id, role)
  values (v_target_user_id, v_invite.workspace_id, v_invite.role)
  on conflict (id) do update
  set workspace_id = excluded.workspace_id,
      role = excluded.role;

  update public.workspace_invites
  set status = 'accepted',
      accepted_at = now(),
      accepted_by = v_target_user_id
  where id = v_invite.id;

  return json_build_object(
    'workspace_id', v_invite.workspace_id,
    'role', v_invite.role,
    'status', 'accepted'
  );
end;
$$;

-- =====================================================
-- 6) Create a profile for every new auth user
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
  v_role := coalesce(new.raw_user_meta_data ->> 'role', 'agent');

  if v_role not in ('super_admin', 'agency_lead', 'agent') then
    v_role := 'agent';
  end if;

  -- If metadata includes workspace_id, use it; otherwise leave null
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_auth_user();

-- =====================================================
-- 7) RLS for workspace_invites
-- =====================================================
alter table public.workspace_invites enable row level security;

drop policy if exists "workspace_invites_select_same_workspace" on public.workspace_invites;
create policy "workspace_invites_select_same_workspace"
on public.workspace_invites
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = workspace_invites.workspace_id
      and p.role in ('super_admin', 'agency_lead')
  )
);

drop policy if exists "workspace_invites_insert_same_workspace" on public.workspace_invites;
create policy "workspace_invites_insert_same_workspace"
on public.workspace_invites
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = workspace_invites.workspace_id
      and p.role in ('super_admin', 'agency_lead')
  )
);

drop policy if exists "workspace_invites_update_same_workspace" on public.workspace_invites;
create policy "workspace_invites_update_same_workspace"
on public.workspace_invites
for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = workspace_invites.workspace_id
      and p.role in ('super_admin', 'agency_lead')
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = workspace_invites.workspace_id
      and p.role in ('super_admin', 'agency_lead')
  )
);

commit;
