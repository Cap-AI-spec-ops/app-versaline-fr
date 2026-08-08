-- Twilio integration tables: subaccount mapping, phone numbers, audit log, and AI summaries.
-- Zero-retention design: no raw message bodies or call transcripts stored.

begin;

-- One Twilio subaccount per workspace, under the platform master account.
create table if not exists public.workspace_twilio_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  subaccount_sid text not null,
  friendly_name text,
  status text not null default 'active',
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_twilio_accounts_unique_workspace unique (workspace_id),
  constraint workspace_twilio_accounts_status_check check (status in ('active', 'suspended', 'deprovisioned')),
  constraint workspace_twilio_accounts_sid_not_empty check (length(trim(subaccount_sid)) > 0)
);

create index if not exists workspace_twilio_accounts_company_idx
  on public.workspace_twilio_accounts (company_id);

-- Phone numbers owned by a workspace; used to route inbound webhooks to the right workspace.
create table if not exists public.workspace_twilio_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  twilio_account_id uuid not null references public.workspace_twilio_accounts(id) on delete cascade,
  phone_number text not null,
  phone_number_sid text not null,
  friendly_name text,
  capabilities_sms boolean not null default false,
  capabilities_mms boolean not null default false,
  capabilities_voice boolean not null default false,
  capabilities_whatsapp boolean not null default false,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_twilio_numbers_unique_sid unique (phone_number_sid),
  constraint workspace_twilio_numbers_status_check check (status in ('active', 'inactive', 'released')),
  constraint workspace_twilio_numbers_phone_not_empty check (length(trim(phone_number)) > 0),
  constraint workspace_twilio_numbers_sid_not_empty check (length(trim(phone_number_sid)) > 0)
);

create index if not exists workspace_twilio_numbers_workspace_idx
  on public.workspace_twilio_numbers (workspace_id);

-- Lookup index: inbound webhook uses `To` number to identify workspace.
create index if not exists workspace_twilio_numbers_phone_idx
  on public.workspace_twilio_numbers (phone_number);

-- Idempotent event audit log keyed by Twilio SID; no raw content stored.
create table if not exists public.twilio_audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid null references public.crm_contacts(id) on delete set null,
  twilio_number_id uuid null references public.workspace_twilio_numbers(id) on delete set null,
  channel text not null,
  direction text not null,
  twilio_sid text not null,
  from_number_hash text not null,
  to_number_hash text not null,
  processing_status text not null default 'processed',
  triage_label text,
  triage_reason_code text,
  triage_confidence numeric(5, 4),
  occurred_at timestamptz not null default now(),
  duration_seconds integer,
  recording_enabled boolean,
  consent_obtained boolean,
  created_by uuid null references public.profiles(id) on delete set null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  constraint twilio_audit_logs_unique_sid unique (twilio_sid),
  constraint twilio_audit_logs_channel_check check (channel in ('sms', 'whatsapp', 'voice')),
  constraint twilio_audit_logs_direction_check check (direction in ('inbound', 'outbound')),
  constraint twilio_audit_logs_processing_status_check check (processing_status in ('processed', 'discarded', 'duplicate', 'failed')),
  constraint twilio_audit_logs_triage_label_check check (triage_label is null or triage_label in ('save_summary', 'discard', 'needs_review')),
  constraint twilio_audit_logs_triage_confidence_check check (triage_confidence is null or (triage_confidence >= 0 and triage_confidence <= 1)),
  constraint twilio_audit_logs_sid_not_empty check (length(trim(twilio_sid)) > 0),
  constraint twilio_audit_logs_from_hash_not_empty check (length(trim(from_number_hash)) >= 16),
  constraint twilio_audit_logs_to_hash_not_empty check (length(trim(to_number_hash)) >= 16)
);

create index if not exists twilio_audit_logs_workspace_idx
  on public.twilio_audit_logs (workspace_id, occurred_at desc);

create index if not exists twilio_audit_logs_contact_idx
  on public.twilio_audit_logs (workspace_id, contact_id, occurred_at desc);

-- AI-generated summaries for messages and calls; raw content never persisted.
create table if not exists public.twilio_summaries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  contact_id uuid null references public.crm_contacts(id) on delete set null,
  audit_log_id uuid null references public.twilio_audit_logs(id) on delete set null,
  twilio_number_id uuid null references public.workspace_twilio_numbers(id) on delete set null,
  twilio_sid text not null,
  channel text not null,
  direction text not null,
  summary_text text not null,
  summary_language text not null default 'en',
  model_provider text,
  model_name text,
  triage_reason_code text,
  triage_confidence numeric(5, 4),
  occurred_at timestamptz not null default now(),
  retention_delete_at timestamptz,
  created_by uuid null references public.profiles(id) on delete set null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint twilio_summaries_unique_sid unique (twilio_sid),
  constraint twilio_summaries_channel_check check (channel in ('sms', 'whatsapp', 'voice')),
  constraint twilio_summaries_direction_check check (direction in ('inbound', 'outbound')),
  constraint twilio_summaries_summary_not_empty check (length(trim(summary_text)) > 0),
  constraint twilio_summaries_summary_max_length check (char_length(summary_text) <= 8000),
  constraint twilio_summaries_language_not_empty check (length(trim(summary_language)) > 0),
  constraint twilio_summaries_triage_confidence_check check (triage_confidence is null or (triage_confidence >= 0 and triage_confidence <= 1)),
  constraint twilio_summaries_sid_not_empty check (length(trim(twilio_sid)) > 0)
);

create index if not exists twilio_summaries_workspace_idx
  on public.twilio_summaries (workspace_id, occurred_at desc);

create index if not exists twilio_summaries_contact_idx
  on public.twilio_summaries (workspace_id, contact_id, occurred_at desc);

-- updated_at triggers
create or replace function public.set_updated_at_twilio_summaries()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_twilio_summaries on public.twilio_summaries;
create trigger trg_set_updated_at_twilio_summaries
before update on public.twilio_summaries
for each row execute function public.set_updated_at_twilio_summaries();

create or replace function public.set_updated_at_workspace_twilio_accounts()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_workspace_twilio_accounts on public.workspace_twilio_accounts;
create trigger trg_set_updated_at_workspace_twilio_accounts
before update on public.workspace_twilio_accounts
for each row execute function public.set_updated_at_workspace_twilio_accounts();

create or replace function public.set_updated_at_workspace_twilio_numbers()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_workspace_twilio_numbers on public.workspace_twilio_numbers;
create trigger trg_set_updated_at_workspace_twilio_numbers
before update on public.workspace_twilio_numbers
for each row execute function public.set_updated_at_workspace_twilio_numbers();

-- RLS
alter table public.workspace_twilio_accounts enable row level security;
alter table public.workspace_twilio_numbers enable row level security;
alter table public.twilio_audit_logs enable row level security;
alter table public.twilio_summaries enable row level security;

-- workspace_twilio_accounts: owner/super_admin manage, all workspace members read
drop policy if exists "workspace_twilio_accounts_select" on public.workspace_twilio_accounts;
create policy "workspace_twilio_accounts_select"
on public.workspace_twilio_accounts for select to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "workspace_twilio_accounts_insert" on public.workspace_twilio_accounts;
create policy "workspace_twilio_accounts_insert"
on public.workspace_twilio_accounts for insert to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "workspace_twilio_accounts_update" on public.workspace_twilio_accounts;
create policy "workspace_twilio_accounts_update"
on public.workspace_twilio_accounts for update to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "workspace_twilio_accounts_delete" on public.workspace_twilio_accounts;
create policy "workspace_twilio_accounts_delete"
on public.workspace_twilio_accounts for delete to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

-- workspace_twilio_numbers: same access model as accounts
drop policy if exists "workspace_twilio_numbers_select" on public.workspace_twilio_numbers;
create policy "workspace_twilio_numbers_select"
on public.workspace_twilio_numbers for select to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "workspace_twilio_numbers_insert" on public.workspace_twilio_numbers;
create policy "workspace_twilio_numbers_insert"
on public.workspace_twilio_numbers for insert to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "workspace_twilio_numbers_update" on public.workspace_twilio_numbers;
create policy "workspace_twilio_numbers_update"
on public.workspace_twilio_numbers for update to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "workspace_twilio_numbers_delete" on public.workspace_twilio_numbers;
create policy "workspace_twilio_numbers_delete"
on public.workspace_twilio_numbers for delete to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

-- twilio_audit_logs: read-only for all workspace members; writes are service_role only
drop policy if exists "twilio_audit_logs_select" on public.twilio_audit_logs;
create policy "twilio_audit_logs_select"
on public.twilio_audit_logs for select to authenticated
using (public.can_access_workspace(workspace_id));

-- twilio_summaries: all workspace members read; owner/super_admin can delete
drop policy if exists "twilio_summaries_select" on public.twilio_summaries;
create policy "twilio_summaries_select"
on public.twilio_summaries for select to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "twilio_summaries_delete" on public.twilio_summaries;
create policy "twilio_summaries_delete"
on public.twilio_summaries for delete to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

-- Service role needs full access for webhook processors (no RLS bypass needed, explicit grants)
grant select, insert, update on table public.workspace_twilio_accounts to service_role;
grant select, insert, update on table public.workspace_twilio_numbers to service_role;
grant select, insert, update on table public.twilio_audit_logs to service_role;
grant select, insert, update, delete on table public.twilio_summaries to service_role;

-- Authenticated users need access for settings UI
grant select, insert, update, delete on table public.workspace_twilio_accounts to authenticated;
grant select, insert, update, delete on table public.workspace_twilio_numbers to authenticated;
grant select on table public.twilio_audit_logs to authenticated;
grant select, delete on table public.twilio_summaries to authenticated;

-- Phone-based contact lookup used by inbound webhook triage (mirrors find_contact_by_email).
create or replace function public.find_contact_by_phone(
  p_workspace_id uuid,
  p_phone text
)
returns table (id uuid)
language sql
security definer
set search_path = public, auth
set row_security = off
stable
as $$
  select c.id
  from public.crm_contacts c
  where c.workspace_id = p_workspace_id
    and c.phone is not null
    and trim(c.phone) = trim(p_phone)
  order by c.updated_at desc, c.id
  limit 5
$$;

grant execute on function public.find_contact_by_phone(uuid, text) to authenticated, service_role;

-- Seed default AI model settings for Twilio triage and summary actions.
insert into public.ai_model_settings (action_type, provider, model, workspace_id, is_active)
values ('twilio_message_triage', 'gemini', 'gemini-2.5-flash-lite', null, true)
on conflict (action_type, provider) where workspace_id is null
  do update set model = excluded.model, is_active = excluded.is_active, updated_at = now();

insert into public.ai_model_settings (action_type, provider, model, workspace_id, is_active)
values ('twilio_message_summary', 'gemini', 'gemini-2.5-flash-lite', null, true)
on conflict (action_type, provider) where workspace_id is null
  do update set model = excluded.model, is_active = excluded.is_active, updated_at = now();

insert into public.ai_model_settings (action_type, provider, model, workspace_id, is_active)
values ('twilio_call_summary', 'gemini', 'gemini-2.5-flash', null, true)
on conflict (action_type, provider) where workspace_id is null
  do update set model = excluded.model, is_active = excluded.is_active, updated_at = now();

commit;
