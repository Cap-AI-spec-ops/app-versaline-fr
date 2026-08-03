-- Allow visit as a CRM contact event type

begin;

alter table if exists public.crm_contact_events
  drop constraint if exists crm_contact_events_event_type_check;

alter table if exists public.crm_contact_events
  add constraint crm_contact_events_event_type_check
  check (event_type in ('note', 'call', 'email', 'meeting', 'visit', 'status_change', 'created'));

commit;
