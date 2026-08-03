-- Grant property table read/write access to authenticated users.
-- The live properties table exists outside the checked-in migrations,
-- so this fix only applies the privileges if the table is present.

begin;

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'properties'
  ) then
    execute 'grant select, insert, update, delete on table public.properties to authenticated';
  end if;
end
$$;

commit;