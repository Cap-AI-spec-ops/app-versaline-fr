-- Persist mailbox OAuth tokens and sync cursor metadata for native in-app polling.

begin;

alter table if exists public.mailbox_connections
add column if not exists oauth_access_token text;

alter table if exists public.mailbox_connections
add column if not exists oauth_refresh_token text;

alter table if exists public.mailbox_connections
add column if not exists oauth_token_updated_at timestamptz;

alter table if exists public.mailbox_connections
add column if not exists sync_cursor text;

commit;
