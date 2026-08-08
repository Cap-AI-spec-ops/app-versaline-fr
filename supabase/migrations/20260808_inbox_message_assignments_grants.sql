begin;

grant select, insert, update, delete on table public.inbox_message_assignments to authenticated;
grant select, insert, update, delete on table public.inbox_message_assignments to service_role;

commit;