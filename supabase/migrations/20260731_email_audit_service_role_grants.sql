-- Ensure service_role can perform inbound email audit/idempotency operations.

begin;

grant select, insert, update, delete on table public.email_audit_logs to service_role;
grant select, insert, update, delete on table public.email_summaries to service_role;

commit;
