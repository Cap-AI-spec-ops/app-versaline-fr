-- Allow daily briefing scheduler (service_role) to read app-managed workspace absences.

begin;

grant select on table public.workspace_absences to service_role;

commit;
