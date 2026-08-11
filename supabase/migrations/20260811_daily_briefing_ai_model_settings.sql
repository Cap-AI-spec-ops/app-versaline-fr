-- Seed daily_briefing action type in ai_model_settings so provider/model can be changed at runtime.

begin;

delete from public.ai_model_settings
where action_type = 'daily_briefing'
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
  'daily_briefing',
  'gemini',
  'gemini-2.5-flash',
  'gemini',
  'gemini-2.5-flash',
  'gemini',
  'gemini-2.5-flash',
  null,
  true
);

commit;
