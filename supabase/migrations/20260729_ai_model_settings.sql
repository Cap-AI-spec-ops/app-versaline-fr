-- Runtime AI model settings (global + workspace override)

begin;

create table if not exists public.ai_model_settings (
  id bigserial primary key,
  action_type text not null,
  provider text not null,
  model text not null,
  workspace_id uuid null references public.workspaces(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_model_settings_action_provider_idx
  on public.ai_model_settings (action_type, provider);

create unique index if not exists ai_model_settings_global_unique_idx
  on public.ai_model_settings (action_type, provider)
  where workspace_id is null;

create unique index if not exists ai_model_settings_workspace_unique_idx
  on public.ai_model_settings (action_type, provider, workspace_id)
  where workspace_id is not null;

alter table public.ai_model_settings enable row level security;

drop policy if exists "ai_model_settings_select" on public.ai_model_settings;
create policy "ai_model_settings_select"
on public.ai_model_settings
for select
to authenticated
using (workspace_id is null or public.can_access_workspace(workspace_id));

drop policy if exists "ai_model_settings_write" on public.ai_model_settings;
create policy "ai_model_settings_write"
on public.ai_model_settings
for all
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'super_admin'
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'super_admin'
  )
);

create or replace function public.set_updated_at_ai_model_settings()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_set_updated_at_ai_model_settings on public.ai_model_settings;
create trigger trg_set_updated_at_ai_model_settings
before update on public.ai_model_settings
for each row
execute function public.set_updated_at_ai_model_settings();

create or replace function public.get_ai_model_setting(
  p_action_type text,
  p_provider text default 'gemini',
  p_workspace_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_model text;
begin
  if p_action_type is null or trim(p_action_type) = '' then
    raise exception 'Action type is required';
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = auth.uid()
  limit 1;

  if v_profile.id is null then
    raise exception 'Profile not found';
  end if;

  if p_workspace_id is not null and not public.can_access_workspace(p_workspace_id) then
    raise exception 'You do not have access to this workspace';
  end if;

  if p_workspace_id is not null then
    select s.model
    into v_model
    from public.ai_model_settings s
    where s.is_active = true
      and s.action_type = trim(p_action_type)
      and s.provider = lower(coalesce(nullif(trim(p_provider), ''), 'gemini'))
      and s.workspace_id = p_workspace_id
    limit 1;

    if v_model is not null then
      return v_model;
    end if;
  end if;

  select s.model
  into v_model
  from public.ai_model_settings s
  where s.is_active = true
    and s.action_type = trim(p_action_type)
    and s.provider = lower(coalesce(nullif(trim(p_provider), ''), 'gemini'))
    and s.workspace_id is null
  limit 1;

  return v_model;
end;
$$;

grant execute on function public.get_ai_model_setting(text, text, uuid) to authenticated;

insert into public.ai_model_settings (action_type, provider, model, workspace_id, is_active)
values ('listing_description', 'gemini', 'gemini-2.0-flash', null, true)
on conflict (action_type, provider) where workspace_id is null
  do update set
    model = excluded.model,
    is_active = excluded.is_active,
    updated_at = now();

commit;
