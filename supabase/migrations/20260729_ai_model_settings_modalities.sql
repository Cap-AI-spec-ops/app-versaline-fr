-- Add text/vision model columns for provider-agnostic multimodal routing

begin;

alter table if exists public.ai_model_settings
add column if not exists text_provider text,
add column if not exists text_model text,
add column if not exists vision_provider text,
add column if not exists vision_model text;

update public.ai_model_settings
set
  text_provider = coalesce(nullif(trim(text_provider), ''), lower(coalesce(nullif(trim(provider), ''), 'gemini'))),
  text_model = coalesce(nullif(trim(text_model), ''), nullif(trim(model), '')),
  vision_provider = coalesce(nullif(trim(vision_provider), ''), lower(coalesce(nullif(trim(provider), ''), 'gemini'))),
  vision_model = coalesce(nullif(trim(vision_model), ''), nullif(trim(model), ''))
where
  text_provider is null
  or nullif(trim(text_provider), '') is null
  or text_model is null
  or nullif(trim(text_model), '') is null
  or vision_provider is null
  or nullif(trim(vision_provider), '') is null
  or vision_model is null
  or nullif(trim(vision_model), '') is null;

do $$
begin
  alter table public.ai_model_settings
  add constraint ai_model_settings_text_provider_not_empty
  check (text_provider is null or length(trim(text_provider)) > 0);
exception when others then
  null;
end $$;

do $$
begin
  alter table public.ai_model_settings
  add constraint ai_model_settings_text_model_not_empty
  check (text_model is null or length(trim(text_model)) > 0);
exception when others then
  null;
end $$;

do $$
begin
  alter table public.ai_model_settings
  add constraint ai_model_settings_vision_provider_not_empty
  check (vision_provider is null or length(trim(vision_provider)) > 0);
exception when others then
  null;
end $$;

do $$
begin
  alter table public.ai_model_settings
  add constraint ai_model_settings_vision_model_not_empty
  check (vision_model is null or length(trim(vision_model)) > 0);
exception when others then
  null;
end $$;

do $$
begin
  alter table public.ai_model_settings
  add constraint ai_model_settings_has_any_model
  check (
    (text_model is not null and length(trim(text_model)) > 0)
    or (vision_model is not null and length(trim(vision_model)) > 0)
    or (model is not null and length(trim(model)) > 0)
  );
exception when others then
  null;
end $$;

create or replace function public.get_ai_model_modalities(
  p_action_type text,
  p_workspace_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.profiles;
  v_row public.ai_model_settings;
  v_action_type text;
begin
  v_action_type := nullif(trim(p_action_type), '');

  if v_action_type is null then
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
    select *
    into v_row
    from public.ai_model_settings s
    where s.is_active = true
      and s.action_type = v_action_type
      and s.workspace_id = p_workspace_id
    order by s.updated_at desc, s.id desc
    limit 1;
  end if;

  if v_row.id is null then
    select *
    into v_row
    from public.ai_model_settings s
    where s.is_active = true
      and s.action_type = v_action_type
      and s.workspace_id is null
    order by s.updated_at desc, s.id desc
    limit 1;
  end if;

  if v_row.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'text_provider', lower(coalesce(nullif(trim(v_row.text_provider), ''), nullif(trim(v_row.provider), ''), 'gemini')),
    'text_model', coalesce(nullif(trim(v_row.text_model), ''), nullif(trim(v_row.model), '')),
    'vision_provider', lower(coalesce(nullif(trim(v_row.vision_provider), ''), nullif(trim(v_row.provider), ''), 'gemini')),
    'vision_model', coalesce(nullif(trim(v_row.vision_model), ''), nullif(trim(v_row.model), '')),
    'workspace_id', v_row.workspace_id,
    'action_type', v_row.action_type
  );
end;
$$;

grant execute on function public.get_ai_model_modalities(text, uuid) to authenticated;

commit;
