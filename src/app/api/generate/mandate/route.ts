import { NextRequest, NextResponse } from "next/server";

import {
  generateWithCredits,
  InsufficientCreditsError,
} from "@/lib/ai/generate-with-credits";
import {
  buildMandateGenerationSystemPrompt,
} from "@/lib/ai/anthropic-client";
import { buildGenerationTelemetry, type GenerationEnvelope } from "@/lib/ai/telemetry";
import { getActionConfig } from "@/lib/ai/model-router";
import { resolveRuntimeModelSelection } from "@/lib/ai/runtime-model-selection";

type MandateGenerationBody = {
  workspaceId: string;
  prompt: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json()) as MandateGenerationBody;
  const actionType = "mandate_generation" as const;
  const actionConfig = getActionConfig(actionType);
  const runtimeModelSelection = await resolveRuntimeModelSelection({
    actionType,
    workspaceId: body.workspaceId,
  });
  const resolvedTextProvider = runtimeModelSelection?.textProvider ?? actionConfig.provider;
  const resolvedTextModel = runtimeModelSelection?.textModel ?? actionConfig.model;
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();

  const systemPrompt = buildMandateGenerationSystemPrompt({
    propertyDetails: `Property details:\n- Workspace: ${body.workspaceId}`,
    clientDetails: `Client details:\n- Prompt context: ${body.prompt}`,
    extraInstructions: "Draft the mandate in French and keep legal clauses aligned with the cached template.",
  });

  try {
    const { result, creditsUsed, newBalance } = await generateWithCredits({
      workspaceId: body.workspaceId,
      actionType,
      idempotencyKey,
      telemetryProvider: resolvedTextProvider,
      telemetryModel: resolvedTextModel,
      generationFn: async (): Promise<GenerationEnvelope<{ model: string; output: string; systemPrompt: unknown }>> => {
        // Replace this stub with your actual Anthropic SDK call.
        // The important part is that the cached system prompt is reused across calls
        // while the property/client details remain in the uncached dynamic block.
        const anthropicResponse = {
          content: [{ type: "text" as const, text: `Mandate draft for: ${body.prompt}` }],
          usage: {
            input_tokens: 1200,
            output_tokens: 340,
            cache_creation_input_tokens: 980,
            cache_read_input_tokens: 0,
          },
        };

        return {
          result: {
            model: resolvedTextModel,
            output: anthropicResponse.content[0]?.text ?? "",
            systemPrompt,
          },
          telemetry: buildGenerationTelemetry({
            provider: resolvedTextProvider,
            model: resolvedTextModel,
            usage: anthropicResponse.usage,
          }),
        };
      },
    });

    return NextResponse.json({
      result,
      creditsUsed,
      newBalance,
    });
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return NextResponse.json(
        {
          error: error.message,
          workspaceId: error.workspaceId,
          actionType: error.actionType,
          requiredCredits: error.requiredCredits,
          currentBalance: error.currentBalance,
        },
        { status: 402 },
      );
    }

    throw error;
  }
}
