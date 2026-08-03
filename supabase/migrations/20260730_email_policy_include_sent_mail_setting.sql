-- Add admin-controlled setting for including sent mail in summaries.

begin;

alter table if exists public.email_ingestion_policies
add column if not exists include_sent_mail_in_summaries boolean not null default false;

commit;
