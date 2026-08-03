-- Durable queue for mailbox sync jobs so cron and Sync now can enqueue work without processing Gmail inline.

begin;

create table if not exists public.mailbox_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  mailbox_connection_id uuid not null references public.mailbox_connections(id) on delete cascade,
  provider text not null,
  requested_by_profile_id uuid references public.profiles(id) on delete set null,
  trigger_source text not null default 'manual',
  status text not null default 'queued',
  attempts integer not null default 0,
  processed_messages integer not null default 0,
  saved_summaries integer not null default 0,
  new_balance numeric(12,2),
  error_message text,
  payload jsonb not null default '{}'::jsonb,
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mailbox_sync_jobs_provider_check check (provider in ('gmail', 'outlook')),
  constraint mailbox_sync_jobs_trigger_source_check check (trigger_source in ('manual', 'cron', 'retry', 'system')),
  constraint mailbox_sync_jobs_status_check check (status in ('queued', 'running', 'succeeded', 'failed'))
);

create index if not exists mailbox_sync_jobs_workspace_idx
  on public.mailbox_sync_jobs (workspace_id, created_at desc);

create index if not exists mailbox_sync_jobs_connection_idx
  on public.mailbox_sync_jobs (mailbox_connection_id, created_at desc);

create index if not exists mailbox_sync_jobs_status_idx
  on public.mailbox_sync_jobs (status, created_at asc);

create unique index if not exists mailbox_sync_jobs_active_unique_idx
  on public.mailbox_sync_jobs (workspace_id, mailbox_connection_id, provider)
  where status in ('queued', 'running');

create or replace function public.set_updated_at_mailbox_sync_jobs()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_mailbox_sync_jobs on public.mailbox_sync_jobs;
create trigger trg_set_updated_at_mailbox_sync_jobs
before update on public.mailbox_sync_jobs
for each row
execute function public.set_updated_at_mailbox_sync_jobs();

create or replace function public.enqueue_mailbox_sync_job(
  p_workspace_id uuid,
  p_mailbox_connection_id uuid,
  p_provider text,
  p_requested_by_profile_id uuid default null,
  p_trigger_source text default 'manual',
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_job public.mailbox_sync_jobs;
  v_existing public.mailbox_sync_jobs;
  v_provider text := lower(coalesce(nullif(trim(p_provider), ''), ''));
  v_trigger_source text := lower(coalesce(nullif(trim(p_trigger_source), ''), 'manual'));
  v_lock_key text;
begin
  if p_workspace_id is null then
    raise exception 'workspace_id is required';
  end if;

  if p_mailbox_connection_id is null then
    raise exception 'mailbox_connection_id is required';
  end if;

  if v_provider not in ('gmail', 'outlook') then
    raise exception 'provider is required';
  end if;

  if v_trigger_source not in ('manual', 'cron', 'retry', 'system') then
    raise exception 'Invalid trigger_source';
  end if;

  v_lock_key := 'mailbox_sync_enqueue:' || p_workspace_id::text || ':' || p_mailbox_connection_id::text || ':' || v_provider;
  perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

  select *
  into v_existing
  from public.mailbox_sync_jobs j
  where j.workspace_id = p_workspace_id
    and j.mailbox_connection_id = p_mailbox_connection_id
    and j.provider = v_provider
    and j.status in ('queued', 'running')
  order by j.created_at asc
  limit 1;

  if found then
    return jsonb_build_object(
      'job_id', v_existing.id,
      'workspace_id', v_existing.workspace_id,
      'mailbox_connection_id', v_existing.mailbox_connection_id,
      'provider', v_existing.provider,
      'status', v_existing.status,
      'queued', false,
      'created_at', v_existing.created_at,
      'payload', v_existing.payload
    );
  end if;

  insert into public.mailbox_sync_jobs (
    workspace_id,
    mailbox_connection_id,
    provider,
    requested_by_profile_id,
    trigger_source,
    status,
    payload
  )
  values (
    p_workspace_id,
    p_mailbox_connection_id,
    v_provider,
    p_requested_by_profile_id,
    v_trigger_source,
    'queued',
    coalesce(p_payload, '{}'::jsonb)
  )
  returning * into v_job;

  return jsonb_build_object(
    'job_id', v_job.id,
    'workspace_id', v_job.workspace_id,
    'mailbox_connection_id', v_job.mailbox_connection_id,
    'provider', v_job.provider,
    'status', v_job.status,
    'queued', true,
    'created_at', v_job.created_at,
    'payload', v_job.payload
  );
end;
$$;

grant execute on function public.enqueue_mailbox_sync_job(uuid, uuid, text, uuid, text, jsonb) to authenticated, service_role;

create or replace function public.reset_stale_mailbox_sync_jobs(
  p_lease_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_reset_count integer := 0;
  v_lease_minutes integer := greatest(coalesce(p_lease_minutes, 30), 1);
begin
  update public.mailbox_sync_jobs
  set
    status = 'queued',
    locked_at = null,
    started_at = null,
    updated_at = now(),
    error_message = coalesce(error_message, 'stale job reset')
  where status = 'running'
    and locked_at is not null
    and locked_at < now() - make_interval(mins => v_lease_minutes)
  ;

  get diagnostics v_reset_count = row_count;

  return coalesce(v_reset_count, 0);
end;
$$;

grant execute on function public.reset_stale_mailbox_sync_jobs(integer) to service_role;

create or replace function public.claim_mailbox_sync_jobs(
  p_limit integer default 5
)
returns setof public.mailbox_sync_jobs
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  return query
  with claimed as (
    select j.id
    from public.mailbox_sync_jobs j
    where j.status = 'queued'
    order by j.created_at asc
    limit greatest(coalesce(p_limit, 1), 1)
    for update skip locked
  )
  update public.mailbox_sync_jobs j
  set
    status = 'running',
    attempts = j.attempts + 1,
    started_at = coalesce(j.started_at, now()),
    locked_at = now(),
    updated_at = now()
  from claimed
  where j.id = claimed.id
  returning j.*;
end;
$$;

grant execute on function public.claim_mailbox_sync_jobs(integer) to service_role;

create or replace function public.complete_mailbox_sync_job(
  p_job_id uuid,
  p_status text,
  p_processed_messages integer default 0,
  p_saved_summaries integer default 0,
  p_new_balance numeric default null,
  p_error_message text default null
)
returns public.mailbox_sync_jobs
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_job public.mailbox_sync_jobs;
  v_status text := lower(coalesce(nullif(trim(p_status), ''), 'failed'));
begin
  if p_job_id is null then
    raise exception 'job_id is required';
  end if;

  if v_status not in ('succeeded', 'failed') then
    raise exception 'Invalid job status';
  end if;

  update public.mailbox_sync_jobs
  set
    status = v_status,
    processed_messages = greatest(coalesce(p_processed_messages, 0), 0),
    saved_summaries = greatest(coalesce(p_saved_summaries, 0), 0),
    new_balance = p_new_balance,
    error_message = nullif(trim(p_error_message), ''),
    completed_at = now(),
    updated_at = now()
  where id = p_job_id
  returning * into v_job;

  if v_job.id is null then
    raise exception 'Job not found';
  end if;

  return v_job;
end;
$$;

grant execute on function public.complete_mailbox_sync_job(uuid, text, integer, integer, numeric, text) to service_role;

commit;
