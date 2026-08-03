-- Credit ledger for workspace-based billing and usage tracking

begin;

create extension if not exists pgcrypto;

-- =====================================================
-- 1) Workspace credit balance
-- =====================================================
alter table if exists public.workspaces
  add column if not exists credit_balance integer;

update public.workspaces
set credit_balance = 0
where credit_balance is null;

alter table if exists public.workspaces
  alter column credit_balance set default 0,
  alter column credit_balance set not null;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_credit_balance_check check (credit_balance >= 0);
exception
  when duplicate_object then null;
end $$;

-- =====================================================
-- 2) Credit transaction ledger
-- =====================================================
create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  amount integer not null,
  type text not null,
  action text,
  idempotency_key text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint credit_transactions_type_check check (type in ('deduction', 'topup', 'refund')),
  constraint credit_transactions_idempotency_key_unique unique (idempotency_key)
);

create index if not exists idx_credit_transactions_workspace_id_created_at
on public.credit_transactions (workspace_id, created_at);

create index if not exists idx_credit_transactions_idempotency_key
on public.credit_transactions (idempotency_key);

-- =====================================================
-- 3) Permissions + RLS
-- =====================================================
grant select, insert on table public.credit_transactions to authenticated;

alter table public.credit_transactions enable row level security;

drop policy if exists "credit_transactions_select_same_workspace" on public.credit_transactions;
create policy "credit_transactions_select_same_workspace"
on public.credit_transactions
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = credit_transactions.workspace_id
  )
);

drop policy if exists "credit_transactions_insert_same_workspace" on public.credit_transactions;
create policy "credit_transactions_insert_same_workspace"
on public.credit_transactions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = credit_transactions.workspace_id
  )
);

-- =====================================================
-- 4) Atomic credit operations
-- =====================================================
-- Advisory locks serialize retries for the same idempotency key.
-- The balance change itself still uses a single UPDATE ... RETURNING
-- so concurrent calls cannot drive the workspace below zero.

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
  v_balance integer;
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

  if not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = p_workspace_id
  ) then
    raise exception 'You do not have access to this workspace';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('deduct:' || v_idempotency_key, 0));

  select *
  into v_existing
  from public.credit_transactions
  where idempotency_key = v_idempotency_key
  limit 1;

  if found then
    v_response := jsonb_build_object(
      'workspace_id', v_existing.workspace_id,
      'transaction_id', v_existing.id,
      'transaction_type', v_existing.type,
      'amount', v_existing.amount,
      'balance', coalesce((v_existing.metadata ->> 'balance_after')::integer, 0),
      'idempotent', true
    );

    return v_response;
  end if;

  update public.workspaces
  set credit_balance = credit_balance - p_amount
  where id = p_workspace_id
    and credit_balance >= p_amount
  returning credit_balance into v_balance;

  if not found then
    raise exception 'Insufficient credits';
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
      'requested_amount', p_amount
    )
  )
  returning * into v_transaction;

  v_response := jsonb_build_object(
    'workspace_id', v_transaction.workspace_id,
    'transaction_id', v_transaction.id,
    'transaction_type', v_transaction.type,
    'amount', v_transaction.amount,
    'balance', v_balance,
    'idempotent', false
  );

  return v_response;
end;
$$;

grant execute on function public.deduct_workspace_credit(uuid, integer, text, text, jsonb) to authenticated;

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
  v_balance integer;
  v_original public.credit_transactions;
  v_existing public.credit_transactions;
  v_transaction public.credit_transactions;
  v_original_key text := nullif(trim(p_idempotency_key), '');
  v_refund_key text;
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  v_refund_amount integer;
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

  if not exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.workspace_id = p_workspace_id
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
    v_response := jsonb_build_object(
      'workspace_id', v_existing.workspace_id,
      'transaction_id', v_existing.id,
      'transaction_type', v_existing.type,
      'amount', v_existing.amount,
      'balance', coalesce((v_existing.metadata ->> 'balance_after')::integer, 0),
      'idempotent', true
    );

    return v_response;
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

  update public.workspaces
  set credit_balance = credit_balance + v_refund_amount
  where id = p_workspace_id
  returning credit_balance into v_balance;

  if not found then
    raise exception 'Workspace not found';
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
      'refunded_amount', v_refund_amount
    )
  )
  returning * into v_transaction;

  v_response := jsonb_build_object(
    'workspace_id', v_transaction.workspace_id,
    'transaction_id', v_transaction.id,
    'transaction_type', v_transaction.type,
    'amount', v_transaction.amount,
    'balance', v_balance,
    'idempotent', false
  );

  return v_response;
end;
$$;

grant execute on function public.refund_workspace_credit(uuid, integer, text, text, jsonb) to authenticated;

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
begin
  if p_transaction_id is null then
    raise exception 'transaction_id is required';
  end if;

  if p_metadata is null then
    p_metadata := '{}'::jsonb;
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
  set metadata = coalesce(metadata, '{}'::jsonb) || p_metadata
  where id = p_transaction_id
  returning * into v_transaction;

  return v_transaction;
end;
$$;

grant execute on function public.update_credit_transaction_metadata(uuid, jsonb) to authenticated;

commit;