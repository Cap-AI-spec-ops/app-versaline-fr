export type AnthropicSystemPromptBlock = {
  type: "text";
  text: string;
  cache_control?: {
    type: "ephemeral";
  };
};

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AnthropicCacheTelemetry = {
  cacheStatus: "hit" | "miss" | "unknown";
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  cacheTokenSavings: number;
};

export type GenerationEnvelope<TResult> = {
  result: TResult;
  usage?: AnthropicUsage | null;
  cacheTelemetry?: AnthropicCacheTelemetry | null;
};

/**
 * Build a system prompt array that keeps the static block cacheable and the dynamic block uncached.
 *
 * Prompt caching only helps when the same cached block is reused across multiple calls.
 * The first call always pays the full price to create the cache; later calls can read from cache.
 */
export function buildCachedSystemPrompt(
  staticTemplate: string,
  dynamicInstructions: string,
): AnthropicSystemPromptBlock[] {
  return [
    {
      type: "text",
      text: staticTemplate,
      cache_control: {
        type: "ephemeral",
      },
    },
    {
      type: "text",
      text: dynamicInstructions,
    },
  ];
}

/**
 * Mandate generation structure:
 * - cached: the Loi Hoguet template plus compliance rules that stay stable across calls
 * - uncached: the property/client specifics that change per request
 */
export const MANDATE_GENERATION_STATIC_TEMPLATE = [
  "Loi Hoguet legal template and compliance rules.",
  "Keep the legal structure stable across calls so this block can be cached.",
  "Validate all mandatory parties, property, mandate, fee, signature, and notice fields.",
].join("\n");

export function buildMandateGenerationSystemPrompt(options: {
  propertyDetails: string;
  clientDetails: string;
  extraInstructions?: string;
}): AnthropicSystemPromptBlock[] {
  const dynamicInstructions = [
    "Property and client details:",
    options.propertyDetails,
    options.clientDetails,
    options.extraInstructions ? `Extra instructions:\n${options.extraInstructions}` : null,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");

  return buildCachedSystemPrompt(MANDATE_GENERATION_STATIC_TEMPLATE, dynamicInstructions);
}

export function extractAnthropicCacheTelemetry(
  usage: AnthropicUsage | null | undefined,
): AnthropicCacheTelemetry | null {
  if (!usage) {
    return null;
  }

  const cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
  const cacheTokenSavings = cacheReadInputTokens > 0 ? cacheReadInputTokens : 0;

  return {
    cacheStatus: cacheReadInputTokens > 0 ? "hit" : cacheCreationInputTokens > 0 ? "miss" : "unknown",
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cacheTokenSavings,
  };
}
