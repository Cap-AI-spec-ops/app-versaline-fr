-- Harden workspace invite acceptance and align invite permissions

begin;

create or replace function public.generate_invite_token()
returns text
language sql
as $$
  select md5(random()::text || clock_timestamp()::text || coalesce(auth.uid()::text, 'anon') || random()::text);
$$;

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
  else
    raise exception 'Only super admins and agency leads can invite teammates';
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
  v_target_email text;
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

  v_target_user_id := auth.uid();

  if v_target_user_id is null then
    raise exception 'No authenticated user found';
  end if;

  if p_user_id is not null and p_user_id <> v_target_user_id then
    raise exception 'Invite acceptance user mismatch';
  end if;

  select lower(trim(u.email))
  into v_target_email
  from auth.users u
  where u.id = v_target_user_id
  limit 1;

  if v_target_email is null then
    raise exception 'Unable to resolve current user email';
  end if;

  if lower(trim(v_invite.email)) <> v_target_email then
    raise exception 'This invite was issued for a different email address';
  end if;

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

commit;
