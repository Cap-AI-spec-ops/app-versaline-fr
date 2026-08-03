begin;

-- =====================================================
-- 1) Workspace credit allocation policy
-- =====================================================
alter table if exists public.workspaces
  add column if not exists credit_allocation_mode text,
  add column if not exists credit_allocation_control text,
  add column if not exists team_lead_credit_allocation_mode text;

update public.workspaces
set
  credit_allocation_mode = coalesce(credit_allocation_mode, 'workspace_shared'),
  credit_allocation_control = coalesce(credit_allocation_control, 'owner_locked')
where credit_allocation_mode is null
   or credit_allocation_control is null;

alter table if exists public.workspaces
  alter column credit_allocation_mode set default 'workspace_shared',
  alter column credit_allocation_mode set not null,
  alter column credit_allocation_control set default 'owner_locked',
  alter column credit_allocation_control set not null;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_credit_allocation_mode_check
  check (credit_allocation_mode in ('workspace_shared', 'per_person'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_credit_allocation_control_check
  check (credit_allocation_control in ('owner_locked', 'team_lead_select'));
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_team_lead_credit_allocation_mode_check
  check (
    team_lead_credit_allocation_mode is null
    or team_lead_credit_allocation_mode in ('workspace_shared', 'per_person')
  );
exception
  when duplicate_object then null;
end $$;

-- =====================================================
-- 2) Per-member credit balance
-- =====================================================
alter table if exists public.workspace_memberships
  add column if not exists credit_balance integer;

update public.workspace_memberships
set credit_balance = 0
where credit_balance is null;

alter table if exists public.workspace_memberships
  alter column credit_balance set default 0,
  alter column credit_balance set not null;

do $$
begin
  alter table public.workspace_memberships
  add constraint workspace_memberships_credit_balance_check
  check (credit_balance >= 0);
exception
  when duplicate_object then null;
end $$;

-- =====================================================
-- 3) Helper to resolve effective workspace credit mode
-- =====================================================
create or replace function public.get_effective_workspace_credit_mode(
  p_workspace_id uuid
)
returns text
language sql
security definer
set search_path = public, auth
as $$
  select
    case
      when w.credit_allocation_control = 'team_lead_select'
           and w.team_lead_credit_allocation_mode in ('workspace_shared', 'per_person')
        then w.team_lead_credit_allocation_mode
      else coalesce(w.credit_allocation_mode, 'workspace_shared')
    end
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;
$$;

grant execute on function public.get_effective_workspace_credit_mode(uuid) to authenticated;

-- =====================================================
-- 4) Workspace credit policy management
-- =====================================================
create or replace function public.update_workspace_credit_policy(
  p_workspace_id uuid,
  p_credit_allocation_mode text,
  p_credit_allocation_control text,
  p_source text default 'admin_page'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_mode text := lower(coalesce(nullif(trim(p_credit_allocation_mode), ''), 'workspace_shared'));
  v_control text := lower(coalesce(nullif(trim(p_credit_allocation_control), ''), 'owner_locked'));
  v_role text;
  v_workspace public.workspaces;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role not in ('super_admin', 'owner') then
    raise exception 'Only super admins and owners can update credit allocation policy';
  end if;

  if v_mode not in ('workspace_shared', 'per_person') then
    raise exception 'Invalid credit allocation mode';
  end if;

  if v_control not in ('owner_locked', 'team_lead_select') then
    raise exception 'Invalid credit allocation control';
  end if;

  update public.workspaces
  set
    credit_allocation_mode = v_mode,
    credit_allocation_control = v_control,
    team_lead_credit_allocation_mode = case
      when v_control = 'team_lead_select' then team_lead_credit_allocation_mode
      else null
    end
  where id = p_workspace_id
  returning * into v_workspace;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  perform public.write_audit_log(
    p_action => 'workspace_credit_policy_updated',
    p_workspace_id => v_workspace.id,
    p_company_id => v_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => v_workspace.id::text,
    p_metadata => jsonb_build_object(
      'credit_allocation_mode', v_workspace.credit_allocation_mode,
      'credit_allocation_control', v_workspace.credit_allocation_control,
      'team_lead_credit_allocation_mode', v_workspace.team_lead_credit_allocation_mode
    ),
    p_source => p_source
  );

  return jsonb_build_object(
    'workspace_id', v_workspace.id,
    'credit_allocation_mode', v_workspace.credit_allocation_mode,
    'credit_allocation_control', v_workspace.credit_allocation_control,
    'team_lead_credit_allocation_mode', v_workspace.team_lead_credit_allocation_mode,
    'effective_credit_allocation_mode', public.get_effective_workspace_credit_mode(v_workspace.id)
  );
end;
$$;

grant execute on function public.update_workspace_credit_policy(uuid, text, text, text) to authenticated;

create or replace function public.set_workspace_credit_mode_by_team_lead(
  p_workspace_id uuid,
  p_credit_allocation_mode text,
  p_source text default 'settings_page'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_mode text := lower(coalesce(nullif(trim(p_credit_allocation_mode), ''), 'workspace_shared'));
  v_role text;
  v_workspace public.workspaces;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  if v_mode not in ('workspace_shared', 'per_person') then
    raise exception 'Invalid credit allocation mode';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role not in ('team_lead', 'super_admin') then
    raise exception 'Only team leads can set delegated credit mode';
  end if;

  select *
  into v_workspace
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_workspace.credit_allocation_control <> 'team_lead_select' then
    raise exception 'The owner has locked credit allocation mode for this workspace';
  end if;

  update public.workspaces
  set team_lead_credit_allocation_mode = v_mode
  where id = p_workspace_id
  returning * into v_workspace;

  perform public.write_audit_log(
    p_action => 'workspace_credit_mode_set_by_team_lead',
    p_workspace_id => v_workspace.id,
    p_company_id => v_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => v_workspace.id::text,
    p_metadata => jsonb_build_object(
      'team_lead_credit_allocation_mode', v_workspace.team_lead_credit_allocation_mode,
      'effective_credit_allocation_mode', public.get_effective_workspace_credit_mode(v_workspace.id)
    ),
    p_source => p_source
  );

  return jsonb_build_object(
    'workspace_id', v_workspace.id,
    'credit_allocation_mode', v_workspace.credit_allocation_mode,
    'credit_allocation_control', v_workspace.credit_allocation_control,
    'team_lead_credit_allocation_mode', v_workspace.team_lead_credit_allocation_mode,
    'effective_credit_allocation_mode', public.get_effective_workspace_credit_mode(v_workspace.id)
  );
end;
$$;

grant execute on function public.set_workspace_credit_mode_by_team_lead(uuid, text, text) to authenticated;

-- =====================================================
-- 5) Mode-aware credit balance read
-- =====================================================
create or replace function public.get_workspace_credit_balance(
  p_workspace_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_workspace_id uuid;
  v_workspace public.workspaces;
  v_effective_mode text;
  v_user_balance integer := 0;
  v_returned_balance integer := 0;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  v_workspace_id := coalesce(p_workspace_id, v_profile.workspace_id);

  if v_workspace_id is null then
    raise exception 'No workspace selected';
  end if;

  if not (
    public.can_access_workspace(v_workspace_id)
    or v_profile.role = 'super_admin'
  ) then
    raise exception 'You do not have access to this workspace';
  end if;

  select *
  into v_workspace
  from public.workspaces w
  where w.id = v_workspace_id
  limit 1;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_workspace.deleted_at is not null then
    raise exception 'Workspace is archived';
  end if;

  v_effective_mode := public.get_effective_workspace_credit_mode(v_workspace.id);

  if v_effective_mode = 'per_person' then
    select coalesce(m.credit_balance, 0)
    into v_user_balance
    from public.workspace_memberships m
    where m.workspace_id = v_workspace.id
      and m.user_id = auth.uid()
      and m.status = 'active'
    limit 1;

    v_returned_balance := coalesce(v_user_balance, 0);
  else
    v_returned_balance := coalesce(v_workspace.credit_balance, 0);
  end if;

  return jsonb_build_object(
    'workspace_id', v_workspace.id,
    'credit_balance', v_returned_balance,
    'effective_credit_allocation_mode', v_effective_mode,
    'credit_allocation_mode', v_workspace.credit_allocation_mode,
    'credit_allocation_control', v_workspace.credit_allocation_control,
    'team_lead_credit_allocation_mode', v_workspace.team_lead_credit_allocation_mode,
    'workspace_credit_balance', coalesce(v_workspace.credit_balance, 0),
    'user_credit_balance', coalesce(v_user_balance, 0)
  );
end;
$$;

-- =====================================================
-- 6) Mode-aware deduction + refund
-- =====================================================
create or replace function public.deduct_workspace_credit(
  p_workspace_id uuid,
  p_amount integer,
  p_action text,
  p_idempotency_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace public.workspaces;
  v_effective_mode text;
  v_balance integer;
  v_workspace_balance integer;
  v_user_balance integer;
  v_billed_user_id uuid := auth.uid();
  v_existing public.credit_transactions;
  v_transaction public.credit_transactions;
  v_idempotency_key text := nullif(trim(p_idempotency_key), '');
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_response jsonb;
begin
  if p_workspace_id is null then
    raise exception 'workspace_id is required';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;

  if v_idempotency_key is null then
    raise exception 'idempotency_key is required';
  end if;

  if not (
    public.can_access_workspace(p_workspace_id)
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'super_admin'
    )
  ) then
    raise exception 'You do not have access to this workspace';
  end if;

  select *
  into v_workspace
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  if v_workspace.deleted_at is not null then
    raise exception 'Workspace is archived';
  end if;

  v_effective_mode := public.get_effective_workspace_credit_mode(p_workspace_id);

  perform pg_advisory_xact_lock(hashtextextended('deduct:' || v_idempotency_key, 0));

  select *
  into v_existing
  from public.credit_transactions
  where idempotency_key = v_idempotency_key
  limit 1;

  if found then
    return jsonb_build_object(
      'workspace_id', v_existing.workspace_id,
      'transaction_id', v_existing.id,
      'transaction_type', v_existing.type,
      'amount', v_existing.amount,
      'balance', coalesce((v_existing.metadata ->> 'balance_after')::integer, 0),
      'billing_mode', coalesce(v_existing.metadata ->> 'billing_mode', 'workspace_shared'),
      'billed_user_id', v_existing.metadata ->> 'billed_user_id',
      'idempotent', true
    );
  end if;

  if v_effective_mode = 'per_person' then
    update public.workspace_memberships
    set credit_balance = credit_balance - p_amount
    where workspace_id = p_workspace_id
      and user_id = v_billed_user_id
      and status = 'active'
      and credit_balance >= p_amount
    returning credit_balance into v_user_balance;

    if not found then
      raise exception 'Insufficient credits';
    end if;

    v_balance := v_user_balance;
    v_workspace_balance := coalesce(v_workspace.credit_balance, 0);
  else
    update public.workspaces
    set credit_balance = credit_balance - p_amount
    where id = p_workspace_id
      and credit_balance >= p_amount
    returning credit_balance into v_workspace_balance;

    if not found then
      raise exception 'Insufficient credits';
    end if;

    v_balance := v_workspace_balance;
    v_user_balance := 0;
    v_billed_user_id := null;
  end if;

  insert into public.credit_transactions (
    workspace_id,
    amount,
    type,
    action,
    idempotency_key,
    metadata
  )
  values (
    p_workspace_id,
    -p_amount,
    'deduction',
    p_action,
    v_idempotency_key,
    v_metadata || jsonb_build_object(
      'balance_after', v_balance,
      'requested_amount', p_amount,
      'billing_mode', v_effective_mode,
      'billed_user_id', v_billed_user_id,
      'workspace_balance_after', v_workspace_balance,
      'user_balance_after', v_user_balance
    )
  )
  returning * into v_transaction;

  v_response := jsonb_build_object(
    'workspace_id', v_transaction.workspace_id,
    'transaction_id', v_transaction.id,
    'transaction_type', v_transaction.type,
    'amount', v_transaction.amount,
    'balance', v_balance,
    'billing_mode', v_effective_mode,
    'billed_user_id', v_billed_user_id,
    'idempotent', false
  );

  return v_response;
end;
$$;

create or replace function public.refund_workspace_credit(
  p_workspace_id uuid,
  p_amount integer,
  p_action text,
  p_idempotency_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_original public.credit_transactions;
  v_existing public.credit_transactions;
  v_transaction public.credit_transactions;
  v_original_key text := nullif(trim(p_idempotency_key), '');
  v_refund_key text;
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_refund_amount integer;
  v_refund_mode text;
  v_billed_user_id uuid;
  v_workspace_balance integer;
  v_user_balance integer;
  v_balance integer;
  v_response jsonb;
begin
  if p_workspace_id is null then
    raise exception 'workspace_id is required';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;

  if v_original_key is null then
    raise exception 'idempotency_key is required';
  end if;

  if not (
    public.can_access_workspace(p_workspace_id)
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'super_admin'
    )
  ) then
    raise exception 'You do not have access to this workspace';
  end if;

  v_refund_key := 'refund:' || v_original_key;

  perform pg_advisory_xact_lock(hashtextextended(v_refund_key, 0));

  select *
  into v_existing
  from public.credit_transactions
  where idempotency_key = v_refund_key
  limit 1;

  if found then
    return jsonb_build_object(
      'workspace_id', v_existing.workspace_id,
      'transaction_id', v_existing.id,
      'transaction_type', v_existing.type,
      'amount', v_existing.amount,
      'balance', coalesce((v_existing.metadata ->> 'balance_after')::integer, 0),
      'billing_mode', coalesce(v_existing.metadata ->> 'billing_mode', 'workspace_shared'),
      'billed_user_id', v_existing.metadata ->> 'billed_user_id',
      'idempotent', true
    );
  end if;

  select *
  into v_original
  from public.credit_transactions
  where workspace_id = p_workspace_id
    and idempotency_key = v_original_key
    and type = 'deduction'
  limit 1;

  if not found then
    raise exception 'Original deduction not found';
  end if;

  v_refund_amount := abs(v_original.amount);

  if p_amount <> v_refund_amount then
    raise exception 'Refund amount does not match original deduction';
  end if;

  v_refund_mode := coalesce(v_original.metadata ->> 'billing_mode', 'workspace_shared');
  v_billed_user_id := nullif(v_original.metadata ->> 'billed_user_id', '')::uuid;

  if v_refund_mode = 'per_person' then
    if v_billed_user_id is null then
      raise exception 'Original billed user is missing';
    end if;

    update public.workspace_memberships
    set credit_balance = credit_balance + v_refund_amount
    where workspace_id = p_workspace_id
      and user_id = v_billed_user_id
      and status = 'active'
    returning credit_balance into v_user_balance;

    if not found then
      raise exception 'Original billed user membership not found';
    end if;

    v_balance := v_user_balance;

    select coalesce(w.credit_balance, 0)
    into v_workspace_balance
    from public.workspaces w
    where w.id = p_workspace_id
    limit 1;
  else
    update public.workspaces
    set credit_balance = credit_balance + v_refund_amount
    where id = p_workspace_id
    returning credit_balance into v_workspace_balance;

    if not found then
      raise exception 'Workspace not found';
    end if;

    v_balance := v_workspace_balance;
    v_user_balance := 0;
  end if;

  insert into public.credit_transactions (
    workspace_id,
    amount,
    type,
    action,
    idempotency_key,
    metadata
  )
  values (
    p_workspace_id,
    v_refund_amount,
    'refund',
    p_action,
    v_refund_key,
    v_metadata || jsonb_build_object(
      'balance_after', v_balance,
      'refunded_transaction_id', v_original.id,
      'refunded_idempotency_key', v_original_key,
      'refunded_amount', v_refund_amount,
      'billing_mode', v_refund_mode,
      'billed_user_id', v_billed_user_id,
      'workspace_balance_after', v_workspace_balance,
      'user_balance_after', v_user_balance
    )
  )
  returning * into v_transaction;

  v_response := jsonb_build_object(
    'workspace_id', v_transaction.workspace_id,
    'transaction_id', v_transaction.id,
    'transaction_type', v_transaction.type,
    'amount', v_transaction.amount,
    'balance', v_balance,
    'billing_mode', v_refund_mode,
    'billed_user_id', v_billed_user_id,
    'idempotent', false
  );

  return v_response;
end;
$$;

-- =====================================================
-- 7) Onboarding bootstrap with credit policy defaults
-- =====================================================
drop function if exists public.bootstrap_company_workspace(text, text, text, text, text, text);

create or replace function public.bootstrap_company_workspace(
  p_company_name text,
  p_workspace_name text,
  p_currency text default 'EUR',
  p_metric_system text default 'metric',
  p_idempotency_key text default null,
  p_source text default 'onboarding_page',
  p_credit_allocation_mode text default 'workspace_shared',
  p_credit_allocation_control text default 'owner_locked'
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
  v_existing_response jsonb;
begin
  perform public.enforce_rate_limit('bootstrap_company_workspace', 10, 3600);

  v_company_name := nullif(trim(p_company_name), '');
  v_workspace_name := nullif(trim(p_workspace_name), '');
  v_currency := upper(coalesce(nullif(trim(p_currency), ''), 'EUR'));
  v_metric_system := lower(coalesce(nullif(trim(p_metric_system), ''), 'metric'));
  v_credit_allocation_mode := lower(coalesce(nullif(trim(p_credit_allocation_mode), ''), 'workspace_shared'));
  v_credit_allocation_control := lower(coalesce(nullif(trim(p_credit_allocation_control), ''), 'owner_locked'));

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
    company_id,
    credit_allocation_mode,
    credit_allocation_control,
    team_lead_credit_allocation_mode
  )
  values (
    v_workspace_name,
    v_currency,
    v_metric_system,
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

grant execute on function public.bootstrap_company_workspace(text, text, text, text, text, text, text, text) to authenticated;

commit;
