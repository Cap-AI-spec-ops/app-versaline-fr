-- Consolidate chat_assistant model settings to one global authoritative row.

begin;

do $$
declare
  v_keep_id bigint;
  v_provider text;
  v_model text;
begin
  select s.id,
         lower(coalesce(nullif(trim(s.text_provider), ''), nullif(trim(s.provider), ''), 'gemini')),
         coalesce(nullif(trim(s.text_model), ''), nullif(trim(s.model), ''), 'gemini-2.5-flash-lite')
  into v_keep_id, v_provider, v_model
  from public.ai_model_settings s
  where s.action_type = 'chat_assistant'
    and s.workspace_id is null
    and s.is_active = true
  order by s.updated_at desc, s.id desc
  limit 1;

  if v_keep_id is null then
    insert into public.ai_model_settings (
      action_type,
      provider,
      model,
      text_provider,
      text_model,
      vision_provider,
      vision_model,
      workspace_id,
      is_active
    )
    values (
      'chat_assistant',
      'gemini',
      'gemini-2.5-flash-lite',
      'gemini',
      'gemini-2.5-flash-lite',
      'gemini',
      'gemini-2.5-flash-lite',
      null,
      true
    );
  else
    update public.ai_model_settings
    set
      provider = v_provider,
      model = v_model,
      text_provider = v_provider,
      text_model = v_model,
      vision_provider = v_provider,
      vision_model = v_model,
      is_active = true,
      updated_at = now()
    where id = v_keep_id;

    delete from public.ai_model_settings
    where action_type = 'chat_assistant'
      and workspace_id is null
      and id <> v_keep_id;
  end if;
end;
$$;

commit;
