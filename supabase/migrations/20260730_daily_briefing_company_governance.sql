-- Company governance for daily briefing email availability.
-- Owners/super_admins choose global policy, optionally delegated to team leads per workspace.

begin;

alter table if exists public.email_ingestion_policies
add column if not exists daily_briefing_enabled boolean not null default true;

alter table if exists public.email_ingestion_policies
add column if not exists daily_briefing_control text not null default 'owner_locked';

update public.email_ingestion_policies
set daily_briefing_enabled = coalesce(daily_briefing_enabled, true),
    daily_briefing_control = coalesce(daily_briefing_control, 'owner_locked')
where daily_briefing_enabled is null
   or daily_briefing_control is null;

do $$
begin
  alter table public.email_ingestion_policies
  add constraint email_ingestion_policies_daily_briefing_control_check
  check (daily_briefing_control in ('owner_locked', 'team_lead_select'));
exception
  when duplicate_object then null;
end $$;

alter table if exists public.workspaces
add column if not exists team_lead_daily_briefing_enabled boolean;

create or replace function public.get_effective_workspace_daily_briefing_enabled(
  p_workspace_id uuid
)
returns boolean
language sql
security definer
set search_path = public, auth
set row_security = off
stable
as $$
  select
    case
      when coalesce(ep.daily_briefing_control, 'owner_locked') = 'team_lead_select'
        then coalesce(w.team_lead_daily_briefing_enabled, coalesce(ep.daily_briefing_enabled, true))
      else coalesce(ep.daily_briefing_enabled, true)
    end as effective_daily_briefing_enabled
  from public.workspaces w
  left join public.email_ingestion_policies ep
    on ep.company_id = w.company_id
  where w.id = p_workspace_id
  limit 1
$$;

grant execute on function public.get_effective_workspace_daily_briefing_enabled(uuid) to authenticated;

create or replace function public.set_workspace_daily_briefing_by_team_lead(
  p_workspace_id uuid,
  p_is_enabled boolean,
  p_source text default 'daily_briefing_settings'
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace public.workspaces;
  v_profile public.profiles;
  v_policy public.email_ingestion_policies;
  v_role text;
  v_effective boolean;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  if p_is_enabled is null then
    raise exception 'Briefing enabled flag is required';
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  v_role := public.resolve_workspace_role(p_workspace_id);

  if v_role not in ('team_lead', 'super_admin') then
    raise exception 'Only team leads can set delegated daily briefing mode';
  end if;

  if v_role = 'team_lead' and v_profile.workspace_id <> p_workspace_id then
    raise exception 'Team leads can only manage their own workspace';
  end if;

  select *
  into v_workspace
  from public.workspaces w
  where w.id = p_workspace_id
  limit 1;

  if v_workspace.id is null then
    raise exception 'Workspace not found';
  end if;

  select *
  into v_policy
  from public.email_ingestion_policies ep
  where ep.company_id = v_workspace.company_id
  limit 1;

  if coalesce(v_policy.daily_briefing_control, 'owner_locked') <> 'team_lead_select' then
    raise exception 'The owner has locked daily briefing policy for this company';
  end if;

  update public.workspaces
  set team_lead_daily_briefing_enabled = p_is_enabled
  where id = p_workspace_id
  returning * into v_workspace;

  v_effective := public.get_effective_workspace_daily_briefing_enabled(v_workspace.id);

  perform public.write_audit_log(
    p_action => 'workspace_daily_briefing_scope_set_by_team_lead',
    p_workspace_id => v_workspace.id,
    p_company_id => v_workspace.company_id,
    p_target_type => 'workspace',
    p_target_id => v_workspace.id::text,
    p_metadata => jsonb_build_object(
      'team_lead_daily_briefing_enabled', v_workspace.team_lead_daily_briefing_enabled,
      'effective_daily_briefing_enabled', v_effective
    ),
    p_source => p_source
  );

  return jsonb_build_object(
    'workspace_id', v_workspace.id,
    'team_lead_daily_briefing_enabled', v_workspace.team_lead_daily_briefing_enabled,
    'effective_daily_briefing_enabled', v_effective
  );
end;
$$;

grant execute on function public.set_workspace_daily_briefing_by_team_lead(uuid, boolean, text) to authenticated;

commit;
