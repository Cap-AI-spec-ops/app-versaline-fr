-- Hard-fix properties RLS recursion that can surface as "stack depth limit exceeded".
-- The properties table may exist only in live environments, so this migration is defensive.

begin;

do $$
declare
  v_has_properties_table boolean;
  v_has_workspace_id_column boolean;
  v_policy_name text;
begin
  select exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'properties'
  ) into v_has_properties_table;

  if not v_has_properties_table then
    raise notice 'Skipping properties RLS fix: public.properties does not exist in this environment.';
    return;
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'properties'
      and column_name = 'workspace_id'
  ) into v_has_workspace_id_column;

  if not v_has_workspace_id_column then
    raise notice 'Skipping properties RLS fix: public.properties.workspace_id is missing.';
    return;
  end if;

  execute 'alter table public.properties enable row level security';

  for v_policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'properties'
  loop
    execute format('drop policy if exists %I on public.properties', v_policy_name);
  end loop;

  execute $policy$
    create policy "properties_select"
    on public.properties
    for select
    to authenticated
    using (public.can_access_workspace(properties.workspace_id))
  $policy$;

  execute $policy$
    create policy "properties_insert"
    on public.properties
    for insert
    to authenticated
    with check (public.can_access_workspace(properties.workspace_id))
  $policy$;

  execute $policy$
    create policy "properties_update"
    on public.properties
    for update
    to authenticated
    using (public.can_access_workspace(properties.workspace_id))
    with check (public.can_access_workspace(properties.workspace_id))
  $policy$;

  execute $policy$
    create policy "properties_delete"
    on public.properties
    for delete
    to authenticated
    using (public.can_access_workspace(properties.workspace_id))
  $policy$;
end
$$;

commit;
