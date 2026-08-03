-- Grant authenticated users permission to read workspaces used by settings UI

begin;

grant select on table public.workspaces to authenticated;

commit;
