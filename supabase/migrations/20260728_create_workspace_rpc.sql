-- Create workspace RPC for super_admin and owner

begin;

create or replace function public.create_workspace(
  p_name text,
  p_currency text default null,
  p_metric_system text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_workspace public.workspaces;
  v_company_id uuid;
  v_trimmed_name text;
  v_currency text;
  v_metric_system text;
begin
  v_trimmed_name := nullif(trim(p_name), '');
  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'EUR'));
  v_metric_system := lower(coalesce(nullif(trim(p_metric_system), ''), 'metric'));

  if v_trimmed_name is null then
    raise exception 'Workspace name is required';
  end if;

  if v_currency not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if v_metric_system not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can create workspaces';
  end if;

  if v_profile.workspace_id is not null then
    select w.company_id
    into v_company_id
    from public.workspaces w
    where w.id = v_profile.workspace_id
    limit 1;
  end if;

  if v_profile.role = 'owner' and v_company_id is null then
    raise exception 'Owner workspace must be linked to a company before creating workspaces';
  end if;

  insert into public.workspaces (
    name,
    currency,
    metric_system,
    company_id
  )
  values (
    v_trimmed_name,
    v_currency,
    v_metric_system,
    v_company_id
  )
  returning * into v_workspace;

  return v_workspace;
end;
$$;

grant execute on function public.create_workspace(text, text, text) to authenticated;

commit;
