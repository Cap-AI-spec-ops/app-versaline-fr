-- Hard-fix mailbox_connections privileges and RLS policies.
-- Use this when authenticated clients hit: "permission denied for table mailbox_connections".

begin;

alter table if exists public.mailbox_connections enable row level security;

-- Ensure table-level privileges exist for both browser auth and server jobs.
grant select, insert, update, delete on table public.mailbox_connections to authenticated;
grant select, insert, update, delete on table public.mailbox_connections to service_role;

-- Recreate policies to avoid drift.
drop policy if exists "mailbox_connections_select" on public.mailbox_connections;
create policy "mailbox_connections_select"
on public.mailbox_connections
for select
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
);

drop policy if exists "mailbox_connections_insert" on public.mailbox_connections;
create policy "mailbox_connections_insert"
on public.mailbox_connections
for insert
to authenticated
with check (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "mailbox_connections_update" on public.mailbox_connections;
create policy "mailbox_connections_update"
on public.mailbox_connections
for update
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
)
with check (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "mailbox_connections_delete" on public.mailbox_connections;
create policy "mailbox_connections_delete"
on public.mailbox_connections
for delete
to authenticated
using (
  profile_id = auth.uid()
  and public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
);

commit;
