-- Admin permissions smoke test checklist (run manually in Supabase SQL editor)
-- Preconditions:
-- 1) Logged in as super_admin, owner, team_lead, and agent in separate sessions
-- 2) At least two workspaces in one company and one workspace in another company

-- Super admin should create workspace
select public.create_workspace('Smoke SA Workspace', 'EUR', 'metric', 'smoke-sa-create-1', 'sql_smoke');

-- Owner should create workspace in own company
select public.create_workspace('Smoke Owner Workspace', 'EUR', 'metric', 'smoke-owner-create-1', 'sql_smoke');

-- Team lead / agent should fail on create_workspace
-- expect: Only super admins and owners can create workspaces
select public.create_workspace('Should Fail', 'EUR', 'metric', 'smoke-fail-create-1', 'sql_smoke');

-- Workspace switch checks
select * from public.get_accessible_workspaces();
-- switch only to one accessible workspace id from previous output
-- expect success for super_admin and owner; failure for unauthorized scopes
-- select public.switch_workspace('00000000-0000-0000-0000-000000000000');

-- Invite checks
-- select public.create_workspace_invite('<workspace_uuid>', 'invite+smoke@example.com', 'team_lead', null);

-- Soft delete checks
-- 1) Should fail when members_count > 0
-- 2) Should succeed when empty and confirmation name matches
-- select public.delete_workspace('<workspace_uuid>', 'Workspace Exact Name', 'smoke-delete-1', 'sql_smoke');

-- Purge checks (super_admin only, after deleted_at > 24h)
-- select public.purge_deleted_workspace('<workspace_uuid>');

-- Audit checks
select action, actor_email_snapshot, actor_role_snapshot, source, target_type, target_id, created_at
from public.get_audit_logs(100, null, null)
order by created_at desc;
