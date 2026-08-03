-- Secure helper to list members of the authenticated user's current workspace

begin;

create or replace function public.get_workspace_members()
returns table (
  profile_id uuid,
  email text,
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
    lower(trim(u.email)) as email,
    p.role,
    u.created_at as joined_at
  from public.profiles p
  left join auth.users u on u.id = p.id
  where p.workspace_id = v_workspace_id
  order by
    case p.role
      when 'super_admin' then 1
      when 'agency_lead' then 2
      else 3
    end,
    lower(coalesce(u.email, p.id::text));
end;
$$;

grant execute on function public.get_workspace_members() to authenticated;

commit;