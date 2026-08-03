-- Grant document engine table privileges to authenticated users.
-- Needed for environments that already applied 20260802_document_engine.sql
-- before the grants were added there.

begin;

grant select, insert, update, delete on table public.workspace_branding to authenticated;
grant select, insert, update, delete on table public.workspace_custom_templates to authenticated;
grant select, insert, update, delete on table public.workspace_documents to authenticated;
grant select on table public.workspace_mandate_counters to authenticated;

commit;