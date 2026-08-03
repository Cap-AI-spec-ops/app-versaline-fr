-- Persist AI usage directly on credit_transactions so ledger queries can read it without unpacking JSON.

begin;

alter table public.credit_transactions
  add column if not exists provider text,
  add column if not exists model text,
  add column if not exists credits_used integer,
  add column if not exists balance_after integer,
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists total_tokens integer,
  add column if not exists estimated_usd_cost numeric,
  add column if not exists usage_available boolean,
  add column if not exists cache_status text,
  add column if not exists cache_creation_input_tokens integer,
  add column if not exists cache_read_input_tokens integer,
  add column if not exists cache_token_savings integer;

update public.credit_transactions
set
  provider = metadata ->> 'provider',
  model = metadata ->> 'model',
  credits_used = coalesce((metadata ->> 'credits_used')::integer, 0),
  balance_after = (metadata ->> 'balance_after')::integer,
  input_tokens = coalesce((metadata ->> 'input_tokens')::integer, 0),
  output_tokens = coalesce((metadata ->> 'output_tokens')::integer, 0),
  total_tokens = coalesce((metadata ->> 'total_tokens')::integer, 0),
  estimated_usd_cost = coalesce((metadata ->> 'estimated_usd_cost')::numeric, 0),
  usage_available = coalesce((metadata ->> 'usage_available')::boolean, false),
  cache_status = metadata ->> 'cache_status',
  cache_creation_input_tokens = coalesce((metadata ->> 'cache_creation_input_tokens')::integer, 0),
  cache_read_input_tokens = coalesce((metadata ->> 'cache_read_input_tokens')::integer, 0),
  cache_token_savings = coalesce((metadata ->> 'cache_token_savings')::integer, 0)
where metadata is not null;

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
    credits_used = coalesce(nullif(v_metadata ->> 'credits_used', '')::integer, 0),
    balance_after = coalesce(nullif(v_metadata ->> 'balance_after', '')::integer, balance_after),
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

commit;