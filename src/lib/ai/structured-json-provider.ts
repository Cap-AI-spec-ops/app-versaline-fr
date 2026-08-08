import "server-only";

import type { AiProvider } from "@/lib/ai/model-router";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

export async function generateStructuredJson(options: {
  provider: AiProvider;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<unknown> {
  if (options.provider === "gemini") {
    return generateWithGemini(options);
  }

  if (options.provider === "anthropic") {
    return generateWithAnthropic(options);
  }

  if (options.provider === "mistral") {
    return generateWithOpenAiCompatible({
      ...options,
      provider: "mistral",
      baseUrl: process.env.MISTRAL_API_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL,
      apiKey: process.env.MISTRAL_API_KEY?.trim(),
    });
  }

  return generateWithOpenAiCompatible({
    ...options,
    provider: "xai",
    baseUrl: process.env.XAI_API_BASE_URL?.trim() || DEFAULT_XAI_BASE_URL,
    apiKey: process.env.XAI_API_KEY?.trim(),
  });
}

async function generateWithGemini(options: {
  provider: AiProvider;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const baseUrl = (process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/models/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxTokens ?? 700,
        responseMimeType: "application/json",
      },
    }),
  });

  const payload = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";

  if (!response.ok || !text) {
    throw new Error(payload.error?.message ?? `Gemini JSON generation failed (${response.status})`);
  }

  return parseJsonPayload(text);
}

async function generateWithAnthropic(options: {
  provider: AiProvider;
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const baseUrl = (process.env.ANTHROPIC_API_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.model,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 700,
      system: "Return only valid JSON. Do not include markdown fences.",
      messages: [{ role: "user", content: options.prompt }],
    }),
  });

  const payload = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    error?: { message?: string };
  };
  const text = (payload.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("\n")
    .trim();

  if (!response.ok || !text) {
    throw new Error(payload.error?.message ?? `Anthropic JSON generation failed (${response.status})`);
  }

  return parseJsonPayload(text);
}

async function generateWithOpenAiCompatible(options: {
  provider: "mistral" | "xai";
  model: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl: string;
  apiKey: string | undefined;
}) {
  if (!options.apiKey) {
    throw new Error(`${options.provider.toUpperCase()}_API_KEY is not configured`);
  }

  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 700,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Return only valid JSON. Do not include markdown fences.",
        },
        {
          role: "user",
          content: options.prompt,
        },
      ],
    }),
  });

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    error?: { message?: string };
  };

  const rawText = payload.choices?.[0]?.message?.content;
  const text =
    typeof rawText === "string"
      ? rawText.trim()
      : Array.isArray(rawText)
        ? rawText
            .map((part) => (part.type === "text" ? part.text ?? "" : ""))
            .join("\n")
            .trim()
        : "";

  if (!response.ok || !text) {
    throw new Error(payload.error?.message ?? `${options.provider.toUpperCase()} JSON generation failed (${response.status})`);
  }

  return parseJsonPayload(text);
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

    throw new Error("Provider returned invalid JSON payload");
  }
}