-- Twilio add-on governance: owner/super_admin controls company availability,
-- optionally delegated to team leads per workspace (mirrors daily briefing pattern).

begin;

alter table if exists public.email_ingestion_policies
  add column if not exists twilio_control text not null default 'owner_locked';

do $$
begin
  alter table public.email_ingestion_policies
  add constraint email_ingestion_policies_twilio_control_check
  check (twilio_control in ('owner_locked', 'team_lead_select'));
exception
  when duplicate_object then null;
end $$;

alter table if exists public.workspaces
  add column if not exists team_lead_twilio_enabled boolean;

-- Resolves effective Twilio availability for a workspace, respecting company policy and delegation.
create or replace function public.get_effective_workspace_twilio_enabled(
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
      when coalesce(ep.twilio_control, 'owner_locked') = 'team_lead_select'
        then coalesce(w.team_lead_twilio_enabled, coalesce(ep.twilio_enabled, false))
      else coalesce(ep.twilio_enabled, false)
    end
  from public.workspaces w
  left join public.email_ingestion_policies ep
    on ep.company_id = w.company_id
  where w.id = p_workspace_id
  limit 1
$$;

grant execute on function public.get_effective_workspace_twilio_enabled(uuid) to authenticated;
grant execute on function public.get_effective_workspace_twilio_enabled(uuid) to service_role;

-- Allows a team lead to enable/disable Twilio for their own workspace when delegation is active.
create or replace function public.set_workspace_twilio_by_team_lead(
  p_workspace_id uuid,
  p_is_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace public.workspaces;
  v_policy public.email_ingestion_policies;
  v_profile public.profiles;
begin
  if p_workspace_id is null then
    raise exception 'Workspace is required';
  end if;

  select * into v_workspace from public.workspaces where id = p_workspace_id limit 1;
  if v_workspace.id is null then raise exception 'Workspace not found'; end if;

  select * into v_profile from public.profiles where id = auth.uid() limit 1;
  if v_profile.id is null or v_profile.workspace_id <> p_workspace_id then
    raise exception 'Access denied';
  end if;

  if v_profile.role not in ('team_lead', 'owner', 'super_admin') then
    raise exception 'Only team leads and above can update workspace Twilio settings';
  end if;

  if v_workspace.company_id is not null then
    select * into v_policy
    from public.email_ingestion_policies
    where company_id = v_workspace.company_id
    limit 1;

    if v_policy.id is not null and coalesce(v_policy.twilio_control, 'owner_locked') = 'owner_locked' then
      raise exception 'Twilio control is locked by the company owner.';
    end if;
  end if;

  update public.workspaces
  set team_lead_twilio_enabled = p_is_enabled
  where id = p_workspace_id;

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'team_lead_twilio_enabled', p_is_enabled
  );
end;
$$;

grant execute on function public.set_workspace_twilio_by_team_lead(uuid, boolean) to authenticated;

commit;
