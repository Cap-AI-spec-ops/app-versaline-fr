-- Allow service_role writes on mailbox_connections for backend sync/token persistence.

begin;

create or replace function public.mailbox_connections_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_role text := auth.role();
begin
  if v_role = 'service_role' then
    new.provider := lower(trim(new.provider));
    new.summary_language := lower(trim(new.summary_language));
    return new;
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if new.profile_id is null then
    new.profile_id := v_profile.id;
  end if;

  if new.profile_id <> v_profile.id then
    raise exception 'You can only modify your own mailbox connection';
  end if;

  if new.workspace_id is null then
    new.workspace_id := v_profile.workspace_id;
  end if;

  if not public.can_access_workspace(new.workspace_id) then
    raise exception 'Workspace access denied';
  end if;

  new.provider := lower(trim(new.provider));
  new.summary_language := lower(trim(new.summary_language));

  return new;
end;
$$;

commit;
