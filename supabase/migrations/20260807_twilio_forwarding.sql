-- Add call forwarding number to workspace Twilio account config.

begin;

alter table if exists public.workspace_twilio_accounts
  add column if not exists forwarding_number text;

commit;
