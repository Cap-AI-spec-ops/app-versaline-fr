-- Onboarding bootstrap: create first company + workspace for a new account

begin;

create or replace function public.bootstrap_company_workspace(
  p_company_name text,
  p_workspace_name text,
  p_currency text default 'EUR',
  p_metric_system text default 'metric',
  p_idempotency_key text default null,
  p_source text default 'onboarding_page'
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_company public.companies;
  v_workspace public.workspaces;
  v_company_name text;
  v_workspace_name text;
  v_currency text;
  v_metric_system text;
  v_existing_response jsonb;
begin
  perform public.enforce_rate_limit('bootstrap_company_workspace', 10, 3600);

  v_company_name := nullif(trim(p_company_name), '');
  v_workspace_name := nullif(trim(p_workspace_name), '');
  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'EUR'));
  v_metric_system := lower(coalesce(nullif(trim(p_metric_system), ''), 'metric'));

  if v_company_name is null then
    raise exception 'Company name is required';
  end if;

  if v_workspace_name is null then
    raise exception 'Workspace name is required';
  end if;

  if v_currency not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if v_metric_system not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    select i.response
    into v_existing_response
    from public.admin_action_idempotency i
    where i.actor_id = auth.uid()
      and i.action = 'bootstrap_company_workspace'
      and i.idem_key = trim(p_idempotency_key)
    limit 1;

    if v_existing_response is not null then
      return v_existing_response;
    end if;
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.workspace_id is not null then
    raise exception 'This account already has a current workspace';
  end if;

  if exists (
    select 1
    from public.workspace_memberships m
    where m.user_id = v_profile.id
      and m.status = 'active'
  ) then
    raise exception 'This account already belongs to an active workspace';
  end if;

  insert into public.companies (name)
  values (v_company_name)
  returning * into v_company;

  insert into public.workspaces (name, currency, metric_system, company_id)
  values (v_workspace_name, v_currency, v_metric_system, v_company.id)
  returning * into v_workspace;

  update public.profiles
  set
    workspace_id = v_workspace.id,
    role = 'owner'
  where id = v_profile.id;

  insert into public.workspace_memberships (user_id, workspace_id, role, status)
  values (v_profile.id, v_workspace.id, 'owner', 'active')
  on conflict (user_id, workspace_id) do update
  set role = excluded.role,
      status = 'active',
      updated_at = now();

  perform public.write_audit_log(
    p_action => 'company_created',
    p_workspace_id => v_workspace.id,
    p_company_id => v_company.id,
    p_target_type => 'company',
    p_target_id => v_company.id::text,
    p_metadata => jsonb_build_object(
      'company_name', v_company.name,
      'workspace_id', v_workspace.id,
      'workspace_name', v_workspace.name
    ),
    p_source => p_source
  );

  perform public.write_audit_log(
    p_action => 'workspace_created',
    p_workspace_id => v_workspace.id,
    p_company_id => v_company.id,
    p_target_type => 'workspace',
    p_target_id => v_workspace.id::text,
    p_metadata => jsonb_build_object(
      'workspace_name', v_workspace.name,
      'currency', v_workspace.currency,
      'metric_system', v_workspace.metric_system,
      'bootstrap', true
    ),
    p_source => p_source
  );

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    insert into public.admin_action_idempotency (actor_id, action, idem_key, response)
    values (
      auth.uid(),
      'bootstrap_company_workspace',
      trim(p_idempotency_key),
      jsonb_build_object(
        'company_id', v_company.id,
        'workspace_id', v_workspace.id,
        'role', 'owner'
      )
    )
    on conflict (actor_id, action, idem_key) do nothing;
  end if;

  return json_build_object(
    'company_id', v_company.id,
    'company_name', v_company.name,
    'workspace_id', v_workspace.id,
    'workspace_name', v_workspace.name,
    'role', 'owner'
  );
end;
$$;

grant execute on function public.bootstrap_company_workspace(text, text, text, text, text, text) to authenticated;

commit;
