-- Seed all action types that were missing from ai_model_settings so every AI feature
-- resolves its model from the database rather than code-level defaults.

begin;

-- mandate_generation
delete from public.ai_model_settings where action_type = 'mandate_generation' and workspace_id is null;
insert into public.ai_model_settings (action_type, provider, model, text_provider, text_model, vision_provider, vision_model, workspace_id, is_active)
values ('mandate_generation', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', null, true);

-- etat_des_lieux
delete from public.ai_model_settings where action_type = 'etat_des_lieux' and workspace_id is null;
insert into public.ai_model_settings (action_type, provider, model, text_provider, text_model, vision_provider, vision_model, workspace_id, is_active)
values ('etat_des_lieux', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', null, true);

-- valuation_deck
delete from public.ai_model_settings where action_type = 'valuation_deck' and workspace_id is null;
insert into public.ai_model_settings (action_type, provider, model, text_provider, text_model, vision_provider, vision_model, workspace_id, is_active)
values ('valuation_deck', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', null, true);

-- lead_reply
delete from public.ai_model_settings where action_type = 'lead_reply' and workspace_id is null;
insert into public.ai_model_settings (action_type, provider, model, text_provider, text_model, vision_provider, vision_model, workspace_id, is_active)
values ('lead_reply', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', null, true);

-- photo_enhancement_prompt
delete from public.ai_model_settings where action_type = 'photo_enhancement_prompt' and workspace_id is null;
insert into public.ai_model_settings (action_type, provider, model, text_provider, text_model, vision_provider, vision_model, workspace_id, is_active)
values ('photo_enhancement_prompt', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', 'anthropic', 'claude-sonnet-4-20250514', null, true);

-- document_generation
delete from public.ai_model_settings where action_type = 'document_generation' and workspace_id is null;
insert into public.ai_model_settings (action_type, provider, model, text_provider, text_model, vision_provider, vision_model, workspace_id, is_active)
values ('document_generation', 'gemini', 'gemini-2.5-flash', 'gemini', 'gemini-2.5-flash', 'gemini', 'gemini-2.5-flash', null, true);

-- document_special_clause
delete from public.ai_model_settings where action_type = 'document_special_clause' and workspace_id is null;
insert into public.ai_model_settings (action_type, provider, model, text_provider, text_model, vision_provider, vision_model, workspace_id, is_active)
values ('document_special_clause', 'mistral', 'mistral-large-latest', 'mistral', 'mistral-large-latest', 'mistral', 'mistral-large-latest', null, true);

commit;
