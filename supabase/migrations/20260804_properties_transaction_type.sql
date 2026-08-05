-- Add explicit listing transaction type to properties (sale/rent).

begin;

alter table if exists public.properties
  add column if not exists transaction_type text,
  add column if not exists listing_type text;

update public.properties
set transaction_type = coalesce(transaction_type, listing_type, 'sale')
where transaction_type is null;

update public.properties
set listing_type = coalesce(listing_type, transaction_type)
where listing_type is null;

alter table if exists public.properties
  drop constraint if exists properties_transaction_type_check;

alter table if exists public.properties
  add constraint properties_transaction_type_check
  check (transaction_type in ('sale', 'rent'));

create index if not exists properties_workspace_transaction_type_idx
  on public.properties (workspace_id, transaction_type);

commit;
