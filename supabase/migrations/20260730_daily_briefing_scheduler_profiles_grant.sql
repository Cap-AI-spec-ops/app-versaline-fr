-- Allow scheduler (service_role) to read recipient emails from profiles

begin;

grant select on table public.profiles to service_role;

commit;
