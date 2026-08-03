-- Allow scheduler (service_role) to read data required by daily briefing composition

begin;

grant select on table public.workspaces to service_role;
grant select on table public.crm_contact_assignees to service_role;
grant select on table public.crm_contacts to service_role;
grant select on table public.crm_contact_events to service_role;
grant select on table public.email_summaries to service_role;
grant select on table public.ai_model_settings to service_role;

commit;
