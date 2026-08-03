import "server-only";

import type { AiProvider } from "@/lib/ai/model-router";
import { buildListingDescriptionPrompt, normalizeListingDescriptionDraft, type ListingDescriptionDraft, type ListingDescriptionPromptInput } from "@/lib/ai/listing-description";
import type { AITokenUsage } from "@/lib/ai/telemetry";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-sonnet-20241022";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_MISTRAL_MODEL = "pixtral-12b-2409";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_XAI_MODEL = "grok-2-vision-1212";
const PROVIDER_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.LISTING_DESCRIPTION_PROVIDER_TIMEOUT_MS ?? "90000",
  10,
);

type ListingDescriptionProviderResult = {
  draft: ListingDescriptionDraft;
  usage: AITokenUsage | null;
  provider: AiProvider;
  model: string;
};

export async function generateListingDescriptionWithProvider(
  input: ListingDescriptionPromptInput & {
    imageFiles: File[];
    provider: AiProvider;
    modelOverride?: string | null;
  },
): Promise<ListingDescriptionProviderResult> {
  if (input.provider === "gemini") {
    return generateListingDescriptionWithGemini(input);
  }

  if (input.provider === "anthropic") {
    return generateListingDescriptionWithAnthropic(input);
  }

  if (input.provider === "mistral") {
    return generateListingDescriptionWithOpenAICompatible(input, {
      provider: "mistral",
      baseUrl: process.env.MISTRAL_API_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL,
      apiKey: process.env.MISTRAL_API_KEY?.trim(),
      model: input.modelOverride?.trim() || process.env.MISTRAL_LISTING_DESCRIPTION_MODEL?.trim() || DEFAULT_MISTRAL_MODEL,
      apiKeyHeader: "Authorization",
      apiKeyPrefix: "Bearer ",
      modelFieldName: "model",
      userPromptField: "content",
    });
  }

  if (input.provider === "xai") {
    return generateListingDescriptionWithOpenAICompatible(input, {
      provider: "xai",
      baseUrl: process.env.XAI_API_BASE_URL?.trim() || DEFAULT_XAI_BASE_URL,
      apiKey: process.env.XAI_API_KEY?.trim(),
      model: input.modelOverride?.trim() || process.env.XAI_LISTING_DESCRIPTION_MODEL?.trim() || DEFAULT_XAI_MODEL,
      apiKeyHeader: "Authorization",
      apiKeyPrefix: "Bearer ",
      modelFieldName: "model",
      userPromptField: "content",
    });
  }

  throw new Error(`Listing description provider '${input.provider}' is not supported yet`);
}

async function generateListingDescriptionWithGemini(
  input: ListingDescriptionPromptInput & {
    imageFiles: File[];
    provider: AiProvider;
    modelOverride?: string | null;
  },
): Promise<ListingDescriptionProviderResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const model =
    input.modelOverride?.trim() ||
    process.env.GEMINI_LISTING_DESCRIPTION_MODEL?.trim() ||
    DEFAULT_GEMINI_MODEL;
  const baseUrl = process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL;
  const prompt = buildListingDescriptionPrompt(input);
  const imageParts = await Promise.all(
    input.imageFiles.map(async (file) => ({
      inlineData: {
        mimeType: file.type || "image/jpeg",
        data: await fileToBase64(file),
      },
    })),
  );

  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt,
            },
            ...imageParts,
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        topP: 0.95,
        maxOutputTokens: 1200,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as GeminiGenerateContentResponse;
  const text = extractGeminiCandidateText(payload);

  if (!text) {
    throw new Error("Gemini did not return any text");
  }

  const parsed = parseJsonPayload(text);
  const draft = normalizeListingDescriptionDraft(parsed, input.market, input.imageFiles.length, input.disclosures);

  return {
    draft,
    usage: normalizeGeminiUsage(payload.usageMetadata),
    provider: "gemini",
    model,
  };
}

async function generateListingDescriptionWithAnthropic(
  input: ListingDescriptionPromptInput & {
    imageFiles: File[];
    provider: AiProvider;
    modelOverride?: string | null;
  },
): Promise<ListingDescriptionProviderResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const model =
    input.modelOverride?.trim() ||
    process.env.ANTHROPIC_LISTING_DESCRIPTION_MODEL?.trim() ||
    DEFAULT_ANTHROPIC_MODEL;
  const baseUrl = process.env.ANTHROPIC_API_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL;
  const prompt = buildListingDescriptionPrompt(input);
  const content = [
    {
      type: "text",
      text: prompt,
    },
    ...(await Promise.all(
      input.imageFiles.map(async (file) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: file.type || "image/jpeg",
          data: await fileToBase64(file),
        },
      })),
    )),
  ];

  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.4,
      messages: [
        {
          role: "user",
          content,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as AnthropicGenerateMessageResponse;
  const text = extractAnthropicText(payload);

  if (!text) {
    throw new Error("Anthropic did not return any text");
  }

  const parsed = parseJsonPayload(text);
  const draft = normalizeListingDescriptionDraft(parsed, input.market, input.imageFiles.length, input.disclosures);

  return {
    draft,
    usage: normalizeAnthropicUsage(payload.usage),
    provider: "anthropic",
    model,
  };
}

async function generateListingDescriptionWithOpenAICompatible(
  input: ListingDescriptionPromptInput & {
    imageFiles: File[];
    provider: AiProvider;
    modelOverride?: string | null;
  },
  options: {
    provider: "mistral" | "xai";
    baseUrl: string;
    apiKey: string | undefined;
    model: string;
    apiKeyHeader: "Authorization";
    apiKeyPrefix: "Bearer ";
    modelFieldName: string;
    userPromptField: string;
  },
): Promise<ListingDescriptionProviderResult> {
  if (!options.apiKey) {
    throw new Error(`${options.provider.toUpperCase()}_API_KEY is not configured`);
  }

  const prompt = buildListingDescriptionPrompt(input);
  const imageParts = await Promise.all(
    input.imageFiles.map(async (file) => ({
      type: "image_url",
      image_url: {
        url: `data:${file.type || "image/jpeg"};base64,${await fileToBase64(file)}`,
      },
    })),
  );

  const response = await fetchWithTimeout(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [options.apiKeyHeader]: `${options.apiKeyPrefix}${options.apiKey}`,
    },
    body: JSON.stringify({
      [options.modelFieldName]: options.model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt,
            },
            ...imageParts,
          ],
        },
      ],
      temperature: 0.4,
      top_p: 0.95,
      max_tokens: 1200,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${options.provider.toUpperCase()} request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as OpenAICompatibleGenerateContentResponse;
  const text = extractOpenAICompatibleText(payload);

  if (!text) {
    throw new Error(`${options.provider.toUpperCase()} did not return any text`);
  }

  const parsed = parseJsonPayload(text);
  const draft = normalizeListingDescriptionDraft(parsed, input.market, input.imageFiles.length, input.disclosures);

  return {
    draft,
    usage: normalizeOpenAICompatibleUsage(payload.usage),
    provider: options.provider,
    model: options.model,
  };
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
};

type AnthropicGenerateMessageResponse = {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

type OpenAICompatibleGenerateContentResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{
        type?: string;
        text?: string;
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

function extractGeminiCandidateText(payload: GeminiGenerateContentResponse) {
  const candidate = payload.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  return parts
    .map((part) => part.text?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
}

function extractAnthropicText(payload: AnthropicGenerateMessageResponse) {
  return (payload.content ?? [])
    .map((part) => (part.type === "text" ? part.text?.trim() ?? "" : ""))
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
}

function extractOpenAICompatibleText(payload: OpenAICompatibleGenerateContentResponse) {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text?.trim() ?? "" : ""))
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
  }

  return "";
}

function parseJsonPayload(text: string) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fencedMatch?.[1]?.trim() || trimmed;

  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(jsonText.slice(firstBrace, lastBrace + 1)) as unknown;
    }

    throw new Error(`Model returned invalid JSON: ${text}`);
  }
}

function normalizeGeminiUsage(usage: GeminiGenerateContentResponse["usageMetadata"]): AITokenUsage | null {
  if (!usage) {
    return null;
  }

  return {
    inputTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount,
    cacheReadInputTokens: usage.cachedContentTokenCount,
    raw: usage as unknown as Record<string, unknown>,
  };
}

function normalizeAnthropicUsage(usage: AnthropicGenerateMessageResponse["usage"]): AITokenUsage | null {
  if (!usage) {
    return null;
  }

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    cacheCreationInputTokens: usage.cache_creation_input_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens,
    raw: usage as unknown as Record<string, unknown>,
  };
}

function normalizeOpenAICompatibleUsage(usage: OpenAICompatibleGenerateContentResponse["usage"]): AITokenUsage | null {
  if (!usage) {
    return null;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    raw: usage as unknown as Record<string, unknown>,
  };
}

async function fileToBase64(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Provider request timed out after ${PROVIDER_REQUEST_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
