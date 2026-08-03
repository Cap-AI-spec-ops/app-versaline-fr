-- Robust email lookup for inbound triage.

begin;

create or replace function public.find_contact_by_email(
  p_workspace_id uuid,
  p_email text
)
returns table (id uuid)
language sql
security definer
set search_path = public, auth
set row_security = off
stable
as $$
  select c.id
  from public.crm_contacts c
  where c.workspace_id = p_workspace_id
    and c.email is not null
    and lower(trim(c.email)) = lower(trim(p_email))
  order by c.updated_at desc, c.id
  limit 5
$$;

grant execute on function public.find_contact_by_email(uuid, text) to authenticated, service_role;

commit;
