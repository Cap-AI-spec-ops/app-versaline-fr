begin;

create table if not exists public.inbox_message_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  mailbox_owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  message_id text not null,
  thread_id text,
  assigned_to_profile_id uuid references public.profiles(id) on delete set null,
  assigned_by_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inbox_message_assignments_provider_check check (provider in ('gmail', 'outlook')),
  constraint inbox_message_assignments_message_id_not_empty check (length(trim(message_id)) > 0)
);

create unique index if not exists inbox_message_assignments_unique_idx
  on public.inbox_message_assignments (workspace_id, mailbox_owner_profile_id, provider, message_id);

create index if not exists inbox_message_assignments_lookup_idx
  on public.inbox_message_assignments (workspace_id, mailbox_owner_profile_id, provider, thread_id);

create or replace function public.set_updated_at_inbox_message_assignments()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_inbox_message_assignments on public.inbox_message_assignments;
create trigger trg_set_updated_at_inbox_message_assignments
before update on public.inbox_message_assignments
for each row
execute function public.set_updated_at_inbox_message_assignments();

alter table public.inbox_message_assignments enable row level security;

drop policy if exists "inbox_message_assignments_select" on public.inbox_message_assignments;
create policy "inbox_message_assignments_select"
on public.inbox_message_assignments
for select
to authenticated
using (
  mailbox_owner_profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "inbox_message_assignments_insert" on public.inbox_message_assignments;
create policy "inbox_message_assignments_insert"
on public.inbox_message_assignments
for insert
to authenticated
with check (
  mailbox_owner_profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "inbox_message_assignments_update" on public.inbox_message_assignments;
create policy "inbox_message_assignments_update"
on public.inbox_message_assignments
for update
to authenticated
using (
  mailbox_owner_profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
)
with check (
  mailbox_owner_profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "inbox_message_assignments_delete" on public.inbox_message_assignments;
create policy "inbox_message_assignments_delete"
on public.inbox_message_assignments
for delete
to authenticated
using (
  mailbox_owner_profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

commit;