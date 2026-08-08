begin;

create table if not exists public.workspace_twilio_whatsapp_senders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  twilio_account_id uuid not null references public.workspace_twilio_accounts(id) on delete cascade,
  twilio_number_id uuid not null references public.workspace_twilio_numbers(id) on delete cascade,
  sender_sid text not null,
  sender_id text not null,
  status text not null,
  verification_method text,
  last_synced_at timestamptz,
  error_code text,
  error_message text,
  metadata jsonb,
  created_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_twilio_whatsapp_senders_unique_number unique (twilio_number_id),
  constraint workspace_twilio_whatsapp_senders_unique_sid unique (sender_sid),
  constraint workspace_twilio_whatsapp_senders_sender_sid_not_empty check (length(trim(sender_sid)) > 0),
  constraint workspace_twilio_whatsapp_senders_sender_id_not_empty check (length(trim(sender_id)) > 0),
  constraint workspace_twilio_whatsapp_senders_status_check check (
    status in (
      'CREATING',
      'ONLINE',
      'OFFLINE',
      'PENDING_VERIFICATION',
      'VERIFYING',
      'ONLINE:UPDATING',
      'TWILIO_REVIEW',
      'DRAFT',
      'STUBBED'
    )
  ),
  constraint workspace_twilio_whatsapp_senders_verification_method_check check (
    verification_method is null or verification_method in ('sms', 'voice')
  )
);

create index if not exists workspace_twilio_whatsapp_senders_workspace_idx
  on public.workspace_twilio_whatsapp_senders (workspace_id, created_at desc);

create or replace function public.set_updated_at_workspace_twilio_whatsapp_senders()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_workspace_twilio_whatsapp_senders on public.workspace_twilio_whatsapp_senders;
create trigger trg_set_updated_at_workspace_twilio_whatsapp_senders
before update on public.workspace_twilio_whatsapp_senders
for each row execute function public.set_updated_at_workspace_twilio_whatsapp_senders();

alter table public.workspace_twilio_whatsapp_senders enable row level security;

drop policy if exists "workspace_twilio_whatsapp_senders_select" on public.workspace_twilio_whatsapp_senders;
create policy "workspace_twilio_whatsapp_senders_select"
on public.workspace_twilio_whatsapp_senders for select to authenticated
using (public.can_access_workspace(workspace_id));

drop policy if exists "workspace_twilio_whatsapp_senders_insert" on public.workspace_twilio_whatsapp_senders;
create policy "workspace_twilio_whatsapp_senders_insert"
on public.workspace_twilio_whatsapp_senders for insert to authenticated
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "workspace_twilio_whatsapp_senders_update" on public.workspace_twilio_whatsapp_senders;
create policy "workspace_twilio_whatsapp_senders_update"
on public.workspace_twilio_whatsapp_senders for update to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

drop policy if exists "workspace_twilio_whatsapp_senders_delete" on public.workspace_twilio_whatsapp_senders;
create policy "workspace_twilio_whatsapp_senders_delete"
on public.workspace_twilio_whatsapp_senders for delete to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner')
);

grant select, insert, update, delete on table public.workspace_twilio_whatsapp_senders to service_role;
grant select, insert, update, delete on table public.workspace_twilio_whatsapp_senders to authenticated;

commit;