-- Grant CRM table privileges to authenticated users

begin;

grant select, insert, update, delete on table public.crm_contacts to authenticated;
grant select, insert, update, delete on table public.crm_contact_events to authenticated;

commit;
