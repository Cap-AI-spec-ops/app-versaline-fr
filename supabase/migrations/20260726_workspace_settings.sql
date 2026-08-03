-- Add workspace settings (name, currency, metric_system) to workspaces table

begin;

-- Add columns to workspaces table if they don't exist
alter table if exists public.workspaces
add column if not exists currency text default 'EUR',
add column if not exists metric_system text default 'metric';

-- Add constraints only if they don't exist
do $$
begin
  alter table public.workspaces
  add constraint workspaces_currency_check check (currency in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL'));
exception when others then
  null;
end $$;

do $$
begin
  alter table public.workspaces
  add constraint workspaces_metric_system_check check (metric_system in ('metric', 'imperial'));
exception when others then
  null;
end $$;

-- Create RPC to update workspace settings (with role validation)
create or replace function public.update_workspace_settings(
  p_workspace_id uuid,
  p_name text default null,
  p_currency text default null,
  p_metric_system text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace public.workspaces;
  v_user_role text;
begin
  -- Get current user's role in this workspace
  select role
  into v_user_role
  from public.profiles
  where id = auth.uid()
    and workspace_id = p_workspace_id
  limit 1;

  if v_user_role is null then
    raise exception 'You do not have access to this workspace';
  end if;

  -- Only super_admin and agency_lead can update workspace settings
  if v_user_role not in ('super_admin', 'agency_lead') then
    raise exception 'Only super admins and agency leads can change workspace settings';
  end if;

  -- Validate inputs
  if p_currency is not null and p_currency not in ('USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'INR', 'BRL') then
    raise exception 'Invalid currency';
  end if;

  if p_metric_system is not null and p_metric_system not in ('metric', 'imperial') then
    raise exception 'Invalid metric system';
  end if;

  -- Update workspace
  update public.workspaces
  set
    name = coalesce(p_name, name),
    currency = coalesce(p_currency, currency),
    metric_system = coalesce(p_metric_system, metric_system)
  where id = p_workspace_id
  returning * into v_workspace;

  if v_workspace is null then
    raise exception 'Workspace not found';
  end if;

  return v_workspace;
end;
$$;

-- Enable RLS on workspaces table
alter table public.workspaces enable row level security;

-- Simple: grant all authenticated users access to select all workspaces
-- (filtering happens at application level based on profile.workspace_id)
drop policy if exists "workspaces_select" on public.workspaces;
create policy "workspaces_select"
on public.workspaces
for select
to authenticated
using (true);

-- Grant UPDATE only to super_admin and agency_lead
-- (must match their profile's workspace_id)
drop policy if exists "workspaces_update" on public.workspaces;
create policy "workspaces_update"
on public.workspaces
for update
to authenticated
using (
  exists (
    select 1 from public.profiles 
    where profiles.id = auth.uid() 
    and profiles.workspace_id = workspaces.id
    and profiles.role in ('super_admin', 'agency_lead')
  )
)
with check (
  exists (
    select 1 from public.profiles 
    where profiles.id = auth.uid() 
    and profiles.workspace_id = workspaces.id
    and profiles.role in ('super_admin', 'agency_lead')
  )
);

commit;
