-- Allow service-role scheduler billing while preserving workspace/per-person credit rules.

begin;

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
      'balance', coalesce((v_existing.metadata ->> 'balance_after')::integer, 0),
      'billing_mode', coalesce(v_existing.metadata ->> 'billing_mode', 'workspace_shared'),
      'billed_user_id', v_existing.metadata ->> 'billed_user_id',
      'idempotent', true
    );
  end if;

  if v_effective_mode = 'per_person' then
    if v_billed_user_id is null then
      raise exception 'Billed user is required in per-person mode';
    end if;

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
  v_request_role text := coalesce(auth.role(), '');
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
    v_request_role = 'service_role'
    or public.can_access_workspace(p_workspace_id)
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

  return jsonb_build_object(
    'workspace_id', v_transaction.workspace_id,
    'transaction_id', v_transaction.id,
    'transaction_type', v_transaction.type,
    'amount', v_transaction.amount,
    'balance', v_balance,
    'billing_mode', v_refund_mode,
    'billed_user_id', v_billed_user_id,
    'idempotent', false
  );
end;
$$;

grant execute on function public.deduct_workspace_credit(uuid, integer, text, text, jsonb) to authenticated, service_role;
grant execute on function public.refund_workspace_credit(uuid, integer, text, text, jsonb) to authenticated, service_role;

commit;
