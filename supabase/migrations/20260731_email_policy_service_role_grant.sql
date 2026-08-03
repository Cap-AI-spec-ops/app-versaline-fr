-- Allow service_role to read email ingestion policy rows for inbound triage.

begin;

grant select on table public.email_ingestion_policies to service_role;

commit;
