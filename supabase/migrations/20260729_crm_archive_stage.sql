-- Replace lost stage with archived stage for CRM contacts

begin;

update public.crm_contacts
set stage = 'archived'
where stage = 'closed_lost';

alter table if exists public.crm_contacts
  drop constraint if exists crm_contacts_stage_check;

alter table if exists public.crm_contacts
  add constraint crm_contacts_stage_check
  check (stage in ('new_lead', 'qualified', 'viewing', 'negotiating', 'closed_won', 'archived'));

commit;
