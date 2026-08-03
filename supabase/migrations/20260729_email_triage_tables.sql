-- Zero-retention email triage storage (no raw body / no attachments)
-- Phase 1 + 2: schema contract + idempotent ingestion guardrails

begin;

create table if not exists public.email_audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid null references public.crm_contacts(id) on delete set null,
  mailbox_connection_id uuid not null,
  provider text not null,
  message_id_hash text not null,
  thread_id_hash text,
  processing_status text not null default 'processed',
  triage_label text,
  triage_reason_code text,
  triage_confidence numeric(5,4),
  occurred_at timestamptz not null default now(),
  created_by uuid null references public.profiles(id) on delete set null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint email_audit_logs_provider_not_empty check (length(trim(provider)) > 0),
  constraint email_audit_logs_provider_normalized check (provider = lower(trim(provider))),
  constraint email_audit_logs_message_id_hash_not_empty check (length(trim(message_id_hash)) >= 16),
  constraint email_audit_logs_thread_id_hash_not_empty check (thread_id_hash is null or length(trim(thread_id_hash)) >= 16),
  constraint email_audit_logs_processing_status_check check (processing_status in ('processed', 'discarded', 'duplicate', 'failed')),
  constraint email_audit_logs_triage_label_check check (triage_label is null or triage_label in ('save_summary', 'discard', 'needs_review')),
  constraint email_audit_logs_triage_confidence_check check (
    triage_confidence is null or (triage_confidence >= 0 and triage_confidence <= 1)
  )
);

create unique index if not exists email_audit_logs_dedupe_unique_idx
  on public.email_audit_logs (provider, mailbox_connection_id, message_id_hash);

create index if not exists email_audit_logs_workspace_idx
  on public.email_audit_logs (workspace_id, occurred_at desc);

create index if not exists email_audit_logs_contact_idx
  on public.email_audit_logs (workspace_id, contact_id, occurred_at desc);

create table if not exists public.email_summaries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid null references public.crm_contacts(id) on delete set null,
  audit_log_id uuid null references public.email_audit_logs(id) on delete set null,
  mailbox_connection_id uuid not null,
  provider text not null,
  message_id_hash text not null,
  thread_id_hash text,
  direction text not null default 'incoming',
  subject_hint text,
  summary_text text not null,
  summary_language text not null default 'en',
  model_provider text,
  model_name text,
  triage_reason_code text,
  triage_confidence numeric(5,4),
  received_at timestamptz not null default now(),
  retention_delete_at timestamptz,
  created_by uuid null references public.profiles(id) on delete set null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_summaries_provider_not_empty check (length(trim(provider)) > 0),
  constraint email_summaries_provider_normalized check (provider = lower(trim(provider))),
  constraint email_summaries_message_id_hash_not_empty check (length(trim(message_id_hash)) >= 16),
  constraint email_summaries_thread_id_hash_not_empty check (thread_id_hash is null or length(trim(thread_id_hash)) >= 16),
  constraint email_summaries_direction_check check (direction in ('incoming', 'outgoing')),
  constraint email_summaries_summary_text_not_empty check (length(trim(summary_text)) > 0),
  constraint email_summaries_summary_text_max_length check (char_length(summary_text) <= 8000),
  constraint email_summaries_summary_language_not_empty check (length(trim(summary_language)) > 0),
  constraint email_summaries_triage_confidence_check check (
    triage_confidence is null or (triage_confidence >= 0 and triage_confidence <= 1)
  )
);

create unique index if not exists email_summaries_message_unique_idx
  on public.email_summaries (provider, mailbox_connection_id, message_id_hash);

create index if not exists email_summaries_workspace_idx
  on public.email_summaries (workspace_id, received_at desc);

create index if not exists email_summaries_contact_idx
  on public.email_summaries (workspace_id, contact_id, received_at desc);

create or replace function public.set_updated_at_email_summaries()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_email_summaries on public.email_summaries;
create trigger trg_set_updated_at_email_summaries
before update on public.email_summaries
for each row
execute function public.set_updated_at_email_summaries();

create or replace function public.email_summary_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_contact public.crm_contacts;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if new.created_by is null and v_profile.id is not null then
    new.created_by := v_profile.id;
  end if;

  if new.workspace_id is null and v_profile.workspace_id is not null then
    new.workspace_id := v_profile.workspace_id;
  end if;

  if new.contact_id is not null then
    select *
    into v_contact
    from public.crm_contacts c
    where c.id = new.contact_id
    limit 1;

    if v_contact.id is null then
      raise exception 'Contact not found';
    end if;

    if new.workspace_id is null then
      new.workspace_id := v_contact.workspace_id;
    end if;

    if new.workspace_id <> v_contact.workspace_id then
      raise exception 'Summary workspace must match contact workspace';
    end if;
  end if;

  if new.provider is not null then
    new.provider := lower(trim(new.provider));
  end if;

  if new.model_provider is not null then
    new.model_provider := lower(trim(new.model_provider));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_email_summary_defaults on public.email_summaries;
create trigger trg_email_summary_defaults
before insert on public.email_summaries
for each row
execute function public.email_summary_defaults();

create or replace function public.email_audit_defaults()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_contact public.crm_contacts;
begin
  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if new.created_by is null and v_profile.id is not null then
    new.created_by := v_profile.id;
  end if;

  if new.workspace_id is null and v_profile.workspace_id is not null then
    new.workspace_id := v_profile.workspace_id;
  end if;

  if new.contact_id is not null then
    select *
    into v_contact
    from public.crm_contacts c
    where c.id = new.contact_id
    limit 1;

    if v_contact.id is null then
      raise exception 'Contact not found';
    end if;

    if new.workspace_id is null then
      new.workspace_id := v_contact.workspace_id;
    end if;

    if new.workspace_id <> v_contact.workspace_id then
      raise exception 'Audit workspace must match contact workspace';
    end if;
  end if;

  if new.provider is not null then
    new.provider := lower(trim(new.provider));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_email_audit_defaults on public.email_audit_logs;
create trigger trg_email_audit_defaults
before insert on public.email_audit_logs
for each row
execute function public.email_audit_defaults();

alter table public.email_audit_logs enable row level security;
alter table public.email_summaries enable row level security;

drop policy if exists "email_audit_logs_select" on public.email_audit_logs;
create policy "email_audit_logs_select"
on public.email_audit_logs
for select
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "email_audit_logs_insert" on public.email_audit_logs;
create policy "email_audit_logs_insert"
on public.email_audit_logs
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "email_audit_logs_update" on public.email_audit_logs;
create policy "email_audit_logs_update"
on public.email_audit_logs
for update
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "email_audit_logs_delete" on public.email_audit_logs;
create policy "email_audit_logs_delete"
on public.email_audit_logs
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "email_summaries_select" on public.email_summaries;
create policy "email_summaries_select"
on public.email_summaries
for select
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "email_summaries_insert" on public.email_summaries;
create policy "email_summaries_insert"
on public.email_summaries
for insert
to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "email_summaries_update" on public.email_summaries;
create policy "email_summaries_update"
on public.email_summaries
for update
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead')
);

drop policy if exists "email_summaries_delete" on public.email_summaries;
create policy "email_summaries_delete"
on public.email_summaries
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

grant select, insert, update, delete on table public.email_audit_logs to authenticated;
grant select, insert, update, delete on table public.email_summaries to authenticated;

-- Seed default runtime model settings so summary behavior is adjustable from Supabase.
insert into public.ai_model_settings (action_type, provider, model, workspace_id, is_active)
values ('email_triage', 'gemini', 'gemini-2.0-flash', null, true)
on conflict (action_type, provider) where workspace_id is null
  do update set
    model = excluded.model,
    is_active = excluded.is_active,
    updated_at = now();

insert into public.ai_model_settings (action_type, provider, model, workspace_id, is_active)
values ('email_summary', 'gemini', 'gemini-2.0-flash', null, true)
on conflict (action_type, provider) where workspace_id is null
  do update set
    model = excluded.model,
    is_active = excluded.is_active,
    updated_at = now();

commit;
