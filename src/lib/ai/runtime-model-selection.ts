import "server-only";

import type { AiProvider, ActionType } from "@/lib/ai/model-router";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type RuntimeModelSelection = {
  textProvider: AiProvider;
  textModel: string | null;
  visionProvider: AiProvider;
  visionModel: string | null;
};

export async function resolveRuntimeModelSelection(options: {
  actionType: ActionType;
  workspaceId: string;
}): Promise<RuntimeModelSelection | null> {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return null;
  }

  const { data, error } = await supabase.rpc("get_ai_model_modalities", {
    p_action_type: options.actionType,
    p_workspace_id: options.workspaceId,
  });

  if (error) {
    console.error("Failed to load runtime model selection", error);
    return null;
  }

  if (!data || typeof data !== "object") {
    return null;
  }

  const payload = data as Record<string, unknown>;
  const textProvider = normalizeProvider(payload.text_provider);
  const visionProvider = normalizeProvider(payload.vision_provider);
  const textModel = normalizeModel(payload.text_model);
  const visionModel = normalizeModel(payload.vision_model);

  if (!textModel && !visionModel) {
    return null;
  }

  return {
    textProvider,
    textModel,
    visionProvider,
    visionModel,
  };
}

function normalizeProvider(value: unknown): AiProvider {
  if (value === "anthropic" || value === "gemini" || value === "mistral" || value === "xai") {
    return value;
  }

  return "gemini";
}

function normalizeModel(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const model = value.trim();
  return model.length > 0 ? model : null;
}
