-- Seed chat_assistant action type in ai_model_settings so provider/model can be changed at runtime.

begin;

delete from public.ai_model_settings
where action_type = 'chat_assistant'
  and workspace_id is null;

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

commit;
