import type { AiProvider } from "@/lib/ai/model-router";

export type AITokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  raw?: Record<string, unknown>;
};

export type AIGenerationTelemetry = {
  provider?: AiProvider;
  model?: string;
  usage?: AITokenUsage | null;
};

export type GenerationEnvelope<TResult> = {
  result: TResult;
  telemetry?: AIGenerationTelemetry | null;
  usage?: unknown;
};

type UsageSource = Record<string, unknown> | null | undefined;

function readNumber(source: UsageSource, keys: string[]): number | undefined {
  if (!source) {
    return undefined;
  }

  for (const key of keys) {
    const value = source[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

/**
 * Normalize provider-specific usage payloads into a common token telemetry shape.
 *
 * Each SDK reports usage differently, so we read the common token fields and keep the raw payload
 * for debugging and future provider-specific analysis.
 */
export function extractTokenUsage(usage: unknown): AITokenUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const source = usage as Record<string, unknown>;

  const inputTokens = readNumber(source, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "promptTokenCount",
  ]);

  const outputTokens = readNumber(source, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "completionTokenCount",
  ]);

  const totalTokens = readNumber(source, [
    "total_tokens",
    "totalTokens",
    "tokenCount",
    "usageTokens",
  ]);

  const cacheCreationInputTokens = readNumber(source, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
  ]);

  const cacheReadInputTokens = readNumber(source, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  ]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cacheReadInputTokens === undefined
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    raw: source,
  };
}

export function buildGenerationTelemetry(options: {
  provider?: AiProvider;
  model?: string;
  usage?: unknown;
}): AIGenerationTelemetry | null {
  const normalizedUsage = extractTokenUsage(options.usage);

  if (!options.provider && !options.model && !normalizedUsage) {
    return null;
  }

  return {
    provider: options.provider,
    model: options.model,
    usage: normalizedUsage,
  };
}
