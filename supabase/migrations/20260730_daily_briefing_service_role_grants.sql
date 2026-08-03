-- Grant service_role access for scheduled daily briefing processing

begin;

grant select, insert, update, delete on table public.daily_briefing_preferences to service_role;
grant select, insert, update, delete on table public.daily_briefing_runs to service_role;

commit;
