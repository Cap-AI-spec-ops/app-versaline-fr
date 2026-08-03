-- Storage bucket and policies for finalized workspace documents.

begin;

insert into storage.buckets (id, name, public)
values ('workspace-documents', 'workspace-documents', false)
on conflict (id) do nothing;

drop policy if exists "workspace_documents_storage_select" on storage.objects;
create policy "workspace_documents_storage_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'workspace-documents'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "workspace_documents_storage_insert" on storage.objects;
create policy "workspace_documents_storage_insert"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'workspace-documents'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "workspace_documents_storage_update" on storage.objects;
create policy "workspace_documents_storage_update"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'workspace-documents'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead', 'agent')
)
with check (
  bucket_id = 'workspace-documents'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead', 'agent')
);

drop policy if exists "workspace_documents_storage_delete" on storage.objects;
create policy "workspace_documents_storage_delete"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'workspace-documents'
  and public.can_access_workspace(((storage.foldername(name))[1])::uuid)
  and public.resolve_workspace_role(((storage.foldername(name))[1])::uuid) in ('super_admin', 'owner', 'team_lead')
);

commit;