-- Add workspace market defaults and propagate them through admin/onboarding RPCs

begin;

alter table if exists public.workspaces
add column if not exists default_country_code text default 'FR',
add column if not exists default_locale text default 'fr-FR',
add column if not exists default_language text default 'fr',
add column if not exists default_timezone text default 'Europe/Paris';

update public.workspaces
set
  default_country_code = coalesce(nullif(trim(default_country_code), ''), 'FR'),
  default_locale = coalesce(nullif(trim(default_locale), ''), 'fr-FR'),
  default_language = coalesce(nullif(trim(default_language), ''), 'fr'),
  default_timezone = coalesce(nullif(trim(default_timezone), ''), 'Europe/Paris')
where
  default_country_code is null
  or nullif(trim(default_country_code), '') is null
  or default_locale is null
  or nullif(trim(default_locale), '') is null
  or default_language is null
  or nullif(trim(default_language), '') is null
  or default_timezone is null
  or nullif(trim(default_timezone), '') is null;

alter table public.workspaces
  alter column default_country_code set not null,
  alter column default_locale set not null,
  alter column default_language set not null,
  alter column default_timezone set not null;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_default_country_code_check
  check (default_country_code ~ '^[A-Z]{2}$');
exception when others then
  null;
end $$;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_default_locale_check
  check (default_locale ~ '^[a-z]{2}-[A-Z]{2}$');
exception when others then
  null;
end $$;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_default_language_check
  check (default_language ~ '^[a-z]{2}$');
exception when others then
  null;
end $$;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_default_timezone_check
  check (length(trim(default_timezone)) > 0);
exception when others then
  null;
end $$;

drop function if exists public.get_admin_workspaces();

create or replace function public.get_admin_workspaces()
returns table (
  workspace_id uuid,
  workspace_name text,
  currency text,
  metric_system text,
  default_country_code text,
  default_locale text,
  default_language text,
  default_timezone text,
  company_id uuid,
  company_name text,
  members_count bigint,
  is_current boolean
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

  if v_profile.role = 'super_admin' then
    return query
    select
      w.id,
      w.name,
      w.currency,
      w.metric_system,
      w.default_country_code,
      w.default_locale,
      w.default_language,
      w.default_timezone,
      w.company_id,
      c.name,
      (
        select count(*)
        from public.workspace_memberships m
        where m.workspace_id = w.id
          and m.status = 'active'
      ) as members_count,
      (w.id = v_profile.workspace_id)
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
    where w.deleted_at is null
    order by lower(coalesce(c.name, '')), lower(coalesce(w.name, ''));
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

    return query
    select
      w.id,
      w.name,
      w.currency,
      w.metric_system,
      w.default_country_code,
      w.default_locale,
      w.default_language,
      w.default_timezone,
      w.company_id,
      c.name,
      (
        select count(*)
        from public.workspace_memberships m
        where m.workspace_id = w.id
          and m.status = 'active'
      ) as members_count,
      (w.id = v_profile.workspace_id)
    from public.workspaces w
    left join public.companies c on c.id = w.company_id
    where w.deleted_at is null
      and w.company_id = v_current_company_id
    order by lower(coalesce(w.name, ''));
    return;
  end if;

  raise exception 'Only super admins and owners can access admin workspaces';
end;
$$;

grant execute on function public.get_admin_workspaces() to authenticated;

drop function if exists public.create_workspace(text, text, text, text, text);
drop function if exists public.create_workspace(text, text, text);

create or replace function public.create_workspace(
  p_name text,
  p_currency text default null,
  p_metric_system text default null,
  p_idempotency_key text default null,
  p_source text default 'admin_page',
  p_default_country_code text default 'FR',
  p_default_locale text default 'fr-FR',
  p_default_language text default 'fr',
  p_default_timezone text default 'Europe/Paris'
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
  v_default_country_code text;
  v_default_locale text;
  v_default_language text;
  v_default_timezone text;
  v_existing_response jsonb;
  v_existing_workspace_id uuid;
begin
  perform public.enforce_rate_limit('create_workspace', 25, 3600);

  v_trimmed_name := nullif(trim(p_name), '');
  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'EUR'));
  v_metric_system := lower(coalesce(nullif(trim(p_metric_system), ''), 'metric'));
  v_default_country_code := upper(coalesce(nullif(trim(p_default_country_code), ''), 'FR'));
  v_default_locale := coalesce(nullif(trim(p_default_locale), ''), 'fr-FR');
  v_default_language := lower(coalesce(nullif(trim(p_default_language), ''), 'fr'));
  v_default_timezone := coalesce(nullif(trim(p_default_timezone), ''), 'Europe/Paris');

  if v_trimmed_name is null then
    raise exception 'Workspace name is required';
  end if;

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    select i.response
    into v_existing_response
    from public.admin_action_idempotency i
    where i.actor_id = auth.uid()
      and i.action = 'create_workspace'
      and i.idem_key = trim(p_idempotency_key)
    limit 1;

    if v_existing_response is not null then
      v_existing_workspace_id := (v_existing_response ->> 'workspace_id')::uuid;
      select * into v_workspace from public.workspaces w where w.id = v_existing_workspace_id limit 1;
      if v_workspace.id is not null then
        return v_workspace;
      end if;
    end if;
  end if;

  if v_currency not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if v_metric_system not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  if v_default_country_code !~ '^[A-Z]{2}$' then
    raise exception 'Invalid default country code';
  end if;

  if v_default_locale !~ '^[a-z]{2}-[A-Z]{2}$' then
    raise exception 'Invalid default locale';
  end if;

  if v_default_language !~ '^[a-z]{2}$' then
    raise exception 'Invalid default language';
  end if;

  if length(trim(v_default_timezone)) = 0 then
    raise exception 'Invalid default timezone';
  end if;

  select * into v_profile from public.profiles p where p.id = auth.uid() limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if v_profile.role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can create workspaces';
  end if;

  if v_profile.workspace_id is not null then
    select w.company_id into v_company_id from public.workspaces w where w.id = v_profile.workspace_id limit 1;
  end if;

  if v_profile.role = 'owner' and v_company_id is null then
    raise exception 'Owner workspace must be linked to a company before creating workspaces';
  end if;

  insert into public.workspaces (
    name,
    currency,
    metric_system,
    default_country_code,
    default_locale,
    default_language,
    default_timezone,
    company_id
  )
  values (
    v_trimmed_name,
    v_currency,
    v_metric_system,
    v_default_country_code,
    v_default_locale,
    v_default_language,
    v_default_timezone,
    v_company_id
  )
  returning * into v_workspace;

  insert into public.workspace_memberships (user_id, workspace_id, role, status)
  values (v_profile.id, v_workspace.id, v_profile.role, 'active')
  on conflict (user_id, workspace_id) do update
  set role = excluded.role,
      status = 'active',
      updated_at = now();

  if p_idempotency_key is not null and trim(p_idempotency_key) <> '' then
    insert into public.admin_action_idempotency (actor_id, action, idem_key, response)
    values (
      auth.uid(),
      'create_workspace',
      trim(p_idempotency_key),
      jsonb_build_object('workspace_id', v_workspace.id)
    )
    on conflict (actor_id, action, idem_key) do nothing;
  end if;

  perform public.write_audit_log(
    p_action => 'workspace_created',
    p_workspace_id => v_workspace.id,
    p_company_id => v_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => v_workspace.id::text,
    p_metadata => jsonb_build_object(
      'workspace_name', v_workspace.name,
      'currency', v_workspace.currency,
      'metric_system', v_workspace.metric_system,
      'default_country_code', v_workspace.default_country_code,
      'default_locale', v_workspace.default_locale,
      'default_language', v_workspace.default_language,
      'default_timezone', v_workspace.default_timezone
    ),
    p_source => p_source
  );

  return v_workspace;
end;
$$;

grant execute on function public.create_workspace(text, text, text, text, text, text, text, text, text) to authenticated;

drop function if exists public.update_workspace_settings(uuid, text, text, text);

create or replace function public.update_workspace_settings(
  p_workspace_id uuid,
  p_name text default null,
  p_currency text default null,
  p_metric_system text default null,
  p_default_country_code text default null,
  p_default_locale text default null,
  p_default_language text default null,
  p_default_timezone text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace public.workspaces;
  v_role text;
  v_default_country_code text;
  v_default_locale text;
  v_default_language text;
  v_default_timezone text;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  select *
  into v_workspace
  from public.workspaces w
  where w.id = p_workspace_id
    and w.deleted_at is null
  limit 1;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role is null then
    raise exception 'You do not have access to this workspace';
  end if;

  if v_role not in ('super_admin', 'owner', 'team_lead') then
    raise exception 'Only super admins, owners, and team leads can change workspace settings';
  end if;

  if p_currency is not null and upper(trim(p_currency)) not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if p_metric_system is not null and lower(trim(p_metric_system)) not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  v_default_country_code := case
    when p_default_country_code is null then null
    else upper(trim(p_default_country_code))
  end;

  v_default_locale := case
    when p_default_locale is null then null
    else trim(p_default_locale)
  end;

  v_default_language := case
    when p_default_language is null then null
    else lower(trim(p_default_language))
  end;

  v_default_timezone := case
    when p_default_timezone is null then null
    else trim(p_default_timezone)
  end;

  if v_default_country_code is not null and v_default_country_code !~ '^[A-Z]{2}$' then
    raise exception 'Invalid default country code';
  end if;

  if v_default_locale is not null and v_default_locale !~ '^[a-z]{2}-[A-Z]{2}$' then
    raise exception 'Invalid default locale';
  end if;

  if v_default_language is not null and v_default_language !~ '^[a-z]{2}$' then
    raise exception 'Invalid default language';
  end if;

  if v_default_timezone is not null and length(v_default_timezone) = 0 then
    raise exception 'Invalid default timezone';
  end if;

  update public.workspaces
  set
    name = coalesce(p_name, name),
    currency = coalesce(upper(trim(p_currency)), currency),
    metric_system = coalesce(lower(trim(p_metric_system)), metric_system),
    default_country_code = coalesce(v_default_country_code, default_country_code),
    default_locale = coalesce(v_default_locale, default_locale),
    default_language = coalesce(v_default_language, default_language),
    default_timezone = coalesce(v_default_timezone, default_timezone)
  where id = p_workspace_id
  returning * into v_workspace;

  return v_workspace;
end;
$$;

grant execute on function public.update_workspace_settings(uuid, text, text, text, text, text, text, text) to authenticated;

drop function if exists public.bootstrap_company_workspace(text, text, text, text, text, text, text, text);
drop function if exists public.bootstrap_company_workspace(text, text, text, text, text, text);

create or replace function public.bootstrap_company_workspace(
  p_company_name text,
  p_workspace_name text,
  p_currency text default 'EUR',
  p_metric_system text default 'metric',
  p_idempotency_key text default null,
  p_source text default 'onboarding_page',
  p_credit_allocation_mode text default 'workspace_shared',
  p_credit_allocation_control text default 'owner_locked',
  p_default_country_code text default 'FR',
  p_default_locale text default 'fr-FR',
  p_default_language text default 'fr',
  p_default_timezone text default 'Europe/Paris'
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
  v_credit_allocation_mode text;
  v_credit_allocation_control text;
  v_default_country_code text;
  v_default_locale text;
  v_default_language text;
  v_default_timezone text;
  v_existing_response jsonb;
begin
  perform public.enforce_rate_limit('bootstrap_company_workspace', 10, 3600);

  v_company_name := nullif(trim(p_company_name), '');
  v_workspace_name := nullif(trim(p_workspace_name), '');
  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'EUR'));
  v_metric_system := lower(coalesce(nullif(trim(p_metric_system), ''), 'metric'));
  v_credit_allocation_mode := lower(coalesce(nullif(trim(p_credit_allocation_mode), ''), 'workspace_shared'));
  v_credit_allocation_control := lower(coalesce(nullif(trim(p_credit_allocation_control), ''), 'owner_locked'));
  v_default_country_code := upper(coalesce(nullif(trim(p_default_country_code), ''), 'FR'));
  v_default_locale := coalesce(nullif(trim(p_default_locale), ''), 'fr-FR');
  v_default_language := lower(coalesce(nullif(trim(p_default_language), ''), 'fr'));
  v_default_timezone := coalesce(nullif(trim(p_default_timezone), ''), 'Europe/Paris');

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

  if v_credit_allocation_mode not in ('workspace_shared', 'per_person') then
    raise exception 'Invalid credit allocation mode';
  end if;

  if v_credit_allocation_control not in ('owner_locked', 'team_lead_select') then
    raise exception 'Invalid credit allocation control';
  end if;

  if v_default_country_code !~ '^[A-Z]{2}$' then
    raise exception 'Invalid default country code';
  end if;

  if v_default_locale !~ '^[a-z]{2}-[A-Z]{2}$' then
    raise exception 'Invalid default locale';
  end if;

  if v_default_language !~ '^[a-z]{2}$' then
    raise exception 'Invalid default language';
  end if;

  if length(trim(v_default_timezone)) = 0 then
    raise exception 'Invalid default timezone';
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

  insert into public.workspaces (
    name,
    currency,
    metric_system,
    default_country_code,
    default_locale,
    default_language,
    default_timezone,
    company_id,
    credit_allocation_mode,
    credit_allocation_control,
    team_lead_credit_allocation_mode
  )
  values (
    v_workspace_name,
    v_currency,
    v_metric_system,
    v_default_country_code,
    v_default_locale,
    v_default_language,
    v_default_timezone,
    v_company.id,
    v_credit_allocation_mode,
    v_credit_allocation_control,
    null
  )
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
      'default_country_code', v_workspace.default_country_code,
      'default_locale', v_workspace.default_locale,
      'default_language', v_workspace.default_language,
      'default_timezone', v_workspace.default_timezone,
      'credit_allocation_mode', v_workspace.credit_allocation_mode,
      'credit_allocation_control', v_workspace.credit_allocation_control,
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

grant execute on function public.bootstrap_company_workspace(text, text, text, text, text, text, text, text, text, text, text, text) to authenticated;

commit;
