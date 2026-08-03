-- Reporting views for AI model usage, token consumption, and cost tracking

begin;

-- =====================================================
-- 1) Detailed transaction-level report
-- =====================================================
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
  nullif(ct.metadata ->> 'balance_after', '')::integer as balance_after,
  ct.metadata as metadata
from public.credit_transactions ct
join public.workspaces w on w.id = ct.workspace_id;

grant select on public.ai_credit_transactions_report to authenticated;

-- =====================================================
-- 2) Daily rollup report for dashboards and finance review
-- =====================================================
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