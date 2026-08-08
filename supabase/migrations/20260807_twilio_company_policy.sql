-- Add Twilio add-on feature flags to the company-scoped policy table.
-- Disabled by default; owner/super_admin must opt-in per company.

begin;

alter table if exists public.email_ingestion_policies
  add column if not exists twilio_enabled boolean not null default false;

alter table if exists public.email_ingestion_policies
  add column if not exists twilio_confidence_threshold integer not null default 70;

alter table if exists public.email_ingestion_policies
  add column if not exists twilio_summary_retention_days integer not null default 180;

-- France compliance: recording consent is mandatory before capturing audio/transcript.
alter table if exists public.email_ingestion_policies
  add column if not exists twilio_recording_consent_required boolean not null default true;

alter table if exists public.email_ingestion_policies
  drop constraint if exists email_ingestion_policies_twilio_confidence_check;

alter table if exists public.email_ingestion_policies
  add constraint email_ingestion_policies_twilio_confidence_check
  check (twilio_confidence_threshold between 0 and 100);

alter table if exists public.email_ingestion_policies
  drop constraint if exists email_ingestion_policies_twilio_retention_check;

alter table if exists public.email_ingestion_policies
  add constraint email_ingestion_policies_twilio_retention_check
  check (twilio_summary_retention_days between 30 and 365);

commit;
