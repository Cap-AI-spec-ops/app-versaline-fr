-- Convert credits to decimal amounts so 0.1 charges are supported everywhere.

begin;

drop view if exists public.ai_credit_transactions_report;
drop view if exists public.ai_credit_usage_daily_report;

alter table if exists public.workspaces
  alter column credit_balance type numeric(12,2)
  using coalesce(credit_balance, 0)::numeric(12,2),
  alter column credit_balance set default 0.00;

update public.workspaces
set credit_balance = coalesce(credit_balance, 0.00)
where credit_balance is null;

alter table if exists public.workspaces
  alter column credit_balance set not null;

alter table if exists public.workspace_memberships
  alter column credit_balance type numeric(12,2)
  using coalesce(credit_balance, 0)::numeric(12,2),
  alter column credit_balance set default 0.00;

update public.workspace_memberships
set credit_balance = coalesce(credit_balance, 0.00)
where credit_balance is null;

alter table if exists public.workspace_memberships
  alter column credit_balance set not null;

alter table if exists public.credit_transactions
  alter column amount type numeric(12,2)
  using amount::numeric(12,2);

alter table if exists public.credit_transactions
  alter column amount set not null;

alter table if exists public.credit_transactions
  alter column credits_used type numeric(12,2)
  using coalesce(credits_used, 0)::numeric(12,2);

alter table if exists public.credit_transactions
  alter column balance_after type numeric(12,2)
  using coalesce(balance_after, 0)::numeric(12,2);

drop function if exists public.deduct_workspace_credit(uuid, integer, text, text, jsonb);
drop function if exists public.refund_workspace_credit(uuid, integer, text, text, jsonb);

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
  v_user_balance numeric(12,2) := 0.00;
  v_returned_balance numeric(12,2) := 0.00;
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
    select coalesce(m.credit_balance, 0.00)
    into v_user_balance
    from public.workspace_memberships m
    where m.workspace_id = v_workspace.id
      and m.user_id = auth.uid()
      and m.status = 'active'
    limit 1;

    v_returned_balance := coalesce(v_user_balance, 0.00);
  else
    v_returned_balance := coalesce(v_workspace.credit_balance, 0.00);
  end if;

  return jsonb_build_object(
    'workspace_id', v_workspace.id,
    'credit_balance', v_returned_balance,
    'effective_credit_allocation_mode', v_effective_mode,
    'credit_allocation_mode', v_workspace.credit_allocation_mode,
    'credit_allocation_control', v_workspace.credit_allocation_control,
    'team_lead_credit_allocation_mode', v_workspace.team_lead_credit_allocation_mode,
    'workspace_credit_balance', coalesce(v_workspace.credit_balance, 0.00),
    'user_credit_balance', coalesce(v_user_balance, 0.00)
  );
end;
$$;

create or replace function public.deduct_workspace_credit(
  p_workspace_id uuid,
  p_amount numeric(12,2),
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
  v_balance numeric(12,2);
  v_workspace_balance numeric(12,2);
  v_user_balance numeric(12,2);
  v_billed_user_id uuid := auth.uid();
  v_existing public.credit_transactions;
  v_transaction public.credit_transactions;
  v_idempotency_key text := nullif(trim(p_idempotency_key), '');
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_request_role text := coalesce(auth.role(), '');
  v_metadata_billed_user_id uuid;
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

  if v_request_role = 'service_role' then
    v_metadata_billed_user_id := nullif(v_metadata ->> 'billed_user_id', '')::uuid;

    if v_metadata_billed_user_id is null then
      raise exception 'billed_user_id metadata is required for service-role deductions';
    end if;

    v_billed_user_id := v_metadata_billed_user_id;
  elsif not (
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
      'balance', coalesce((v_existing.metadata ->> 'balance_after')::numeric, 0.00),
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
    v_workspace_balance := coalesce(v_workspace.credit_balance, 0.00);
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
    v_user_balance := 0.00;
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

  return jsonb_build_object(
    'workspace_id', v_transaction.workspace_id,
    'transaction_id', v_transaction.id,
    'transaction_type', v_transaction.type,
    'amount', v_transaction.amount,
    'balance', v_balance,
    'billing_mode', v_effective_mode,
    'billed_user_id', v_billed_user_id,
    'idempotent', false
  );
end;
$$;

grant execute on function public.deduct_workspace_credit(uuid, numeric, text, text, jsonb) to authenticated, service_role;

create or replace function public.refund_workspace_credit(
  p_workspace_id uuid,
  p_amount numeric(12,2),
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
  v_refund_amount numeric(12,2);
  v_refund_mode text;
  v_billed_user_id uuid;
  v_workspace_balance numeric(12,2);
  v_user_balance numeric(12,2);
  v_balance numeric(12,2);
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
      'balance', coalesce((v_existing.metadata ->> 'balance_after')::numeric, 0.00),
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
  v_refund_mode := coalesce(v_original.metadata ->> 'billing_mode', 'workspace_shared');
  v_billed_user_id := nullif(v_original.metadata ->> 'billed_user_id', '')::uuid;

  if p_amount <> v_refund_amount then
    raise exception 'Refund amount does not match original deduction';
  end if;

  if v_refund_mode = 'per_person' then
    update public.workspace_memberships
    set credit_balance = credit_balance + v_refund_amount
    where workspace_id = p_workspace_id
      and user_id = v_billed_user_id
      and status = 'active'
    returning credit_balance into v_user_balance;

    if not found then
      raise exception 'Workspace member not found';
    end if;

    v_balance := v_user_balance;
    v_workspace_balance := coalesce((select w.credit_balance from public.workspaces w where w.id = p_workspace_id), 0.00);
  else
    update public.workspaces
    set credit_balance = credit_balance + v_refund_amount
    where id = p_workspace_id
    returning credit_balance into v_workspace_balance;

    if not found then
      raise exception 'Workspace not found';
    end if;

    v_balance := v_workspace_balance;
    v_user_balance := 0.00;
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

  return jsonb_build_object(
    'workspace_id', v_transaction.workspace_id,
    'transaction_id', v_transaction.id,
    'transaction_type', v_transaction.type,
    'amount', v_transaction.amount,
    'balance', v_balance,
    'idempotent', false
  );
end;
$$;

grant execute on function public.refund_workspace_credit(uuid, numeric, text, text, jsonb) to authenticated, service_role;

create or replace function public.update_credit_transaction_metadata(
  p_transaction_id uuid,
  p_metadata jsonb
)
returns public.credit_transactions
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_transaction public.credit_transactions;
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
begin
  if p_transaction_id is null then
    raise exception 'transaction_id is required';
  end if;

  select ct.*
  into v_transaction
  from public.credit_transactions ct
  join public.profiles p on p.workspace_id = ct.workspace_id
  where ct.id = p_transaction_id
    and p.id = auth.uid()
  limit 1;

  if not found then
    raise exception 'Transaction not found or access denied';
  end if;

  update public.credit_transactions
  set metadata = coalesce(metadata, '{}'::jsonb) || v_metadata
  where id = p_transaction_id
  returning * into v_transaction;

  update public.credit_transactions
  set
    provider = nullif(v_metadata ->> 'provider', ''),
    model = nullif(v_metadata ->> 'model', ''),
    credits_used = coalesce(nullif(v_metadata ->> 'credits_used', '')::numeric, 0.00),
    balance_after = coalesce(nullif(v_metadata ->> 'balance_after', '')::numeric, balance_after),
    input_tokens = coalesce(nullif(v_metadata ->> 'input_tokens', '')::integer, 0),
    output_tokens = coalesce(nullif(v_metadata ->> 'output_tokens', '')::integer, 0),
    total_tokens = coalesce(nullif(v_metadata ->> 'total_tokens', '')::integer, 0),
    estimated_usd_cost = coalesce(nullif(v_metadata ->> 'estimated_usd_cost', '')::numeric, 0),
    usage_available = coalesce(nullif(v_metadata ->> 'usage_available', '')::boolean, false),
    cache_status = nullif(v_metadata ->> 'cache_status', ''),
    cache_creation_input_tokens = coalesce(nullif(v_metadata ->> 'cache_creation_input_tokens', '')::integer, 0),
    cache_read_input_tokens = coalesce(nullif(v_metadata ->> 'cache_read_input_tokens', '')::integer, 0),
    cache_token_savings = coalesce(nullif(v_metadata ->> 'cache_token_savings', '')::integer, 0)
  where id = p_transaction_id
  returning * into v_transaction;

  return v_transaction;
end;
$$;

grant execute on function public.update_credit_transaction_metadata(uuid, jsonb) to authenticated;

create or replace view public.ai_credit_transactions_report
with (security_invoker = true)
as
select
  ct.id as transaction_id,
  ct.workspace_id,
  w.name as workspace_name,
  ct.action,
  ct.type,
  ct.amount as credits_delta,
  ct.idempotency_key,
  ct.created_at,
  ct.metadata ->> 'provider' as provider,
  ct.metadata ->> 'model' as model,
  nullif(ct.metadata ->> 'input_tokens', '')::integer as input_tokens,
  nullif(ct.metadata ->> 'output_tokens', '')::integer as output_tokens,
  nullif(ct.metadata ->> 'total_tokens', '')::integer as total_tokens,
  nullif(ct.metadata ->> 'estimated_usd_cost', '')::numeric as estimated_usd_cost,
  ct.metadata ->> 'cache_status' as cache_status,
  nullif(ct.metadata ->> 'cache_creation_input_tokens', '')::integer as cache_creation_input_tokens,
  nullif(ct.metadata ->> 'cache_read_input_tokens', '')::integer as cache_read_input_tokens,
  nullif(ct.metadata ->> 'cache_token_savings', '')::integer as cache_token_savings,
  nullif(ct.metadata ->> 'balance_after', '')::numeric as balance_after,
  ct.metadata as metadata
from public.credit_transactions ct
join public.workspaces w on w.id = ct.workspace_id;

grant select on public.ai_credit_transactions_report to authenticated;

create or replace view public.ai_credit_usage_daily_report
with (security_invoker = true)
as
select
  date_trunc('day', ct.created_at)::date as usage_date,
  ct.workspace_id,
  w.name as workspace_name,
  ct.metadata ->> 'provider' as provider,
  ct.metadata ->> 'model' as model,
  ct.action,
  count(*) as transaction_count,
  sum(case when ct.type = 'deduction' then abs(ct.amount) else 0 end) as credits_consumed,
  sum(case when ct.type = 'refund' then ct.amount else 0 end) as credits_refunded,
  sum(nullif(ct.metadata ->> 'input_tokens', '')::bigint) as input_tokens,
  sum(nullif(ct.metadata ->> 'output_tokens', '')::bigint) as output_tokens,
  sum(nullif(ct.metadata ->> 'total_tokens', '')::bigint) as total_tokens,
  sum(nullif(ct.metadata ->> 'estimated_usd_cost', '')::numeric) as estimated_usd_cost,
  sum(nullif(ct.metadata ->> 'cache_creation_input_tokens', '')::bigint) as cache_creation_input_tokens,
  sum(nullif(ct.metadata ->> 'cache_read_input_tokens', '')::bigint) as cache_read_input_tokens,
  sum(nullif(ct.metadata ->> 'cache_token_savings', '')::bigint) as cache_token_savings
from public.credit_transactions ct
join public.workspaces w on w.id = ct.workspace_id
group by
  date_trunc('day', ct.created_at)::date,
  ct.workspace_id,
  w.name,
  ct.metadata ->> 'provider',
  ct.metadata ->> 'model',
  ct.action;

grant select on public.ai_credit_usage_daily_report to authenticated;

commit;
