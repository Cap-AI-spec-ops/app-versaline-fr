-- Allow workspace members to edit/delete manual timeline events while protecting system events

begin;

drop policy if exists "crm_contact_events_update" on public.crm_contact_events;
create policy "crm_contact_events_update"
on public.crm_contact_events
for update
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
  and event_type = 'note'
)
with check (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
  and event_type = 'note'
);

drop policy if exists "crm_contact_events_delete" on public.crm_contact_events;
create policy "crm_contact_events_delete"
on public.crm_contact_events
for delete
to authenticated
using (
  public.can_access_workspace(workspace_id)
  and public.resolve_workspace_role(workspace_id) in ('super_admin', 'owner', 'team_lead', 'agent')
  and event_type in ('note', 'call', 'email', 'meeting', 'visit')
);

commit;
