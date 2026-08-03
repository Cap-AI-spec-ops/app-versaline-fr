import "server-only";

import { buildListingDescriptionPrompt, normalizeListingDescriptionDraft, type ListingDescriptionDraft, type ListingDescriptionPromptInput } from "@/lib/ai/listing-description";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

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
  promptFeedback?: unknown;
};

export type GeminiListingDescriptionResult = {
  draft: ListingDescriptionDraft;
  usage: GeminiGenerateContentResponse["usageMetadata"] | null;
  model: string;
};

export async function generateListingDescriptionWithGemini(
  input: ListingDescriptionPromptInput & {
    imageFiles: File[];
    modelOverride?: string | null;
  },
): Promise<GeminiListingDescriptionResult> {
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

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
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
  const text = extractCandidateText(payload);

  if (!text) {
    throw new Error("Gemini did not return any text");
  }

  const parsed = parseJsonPayload(text);
  const draft = normalizeListingDescriptionDraft(parsed, input.market, input.imageFiles.length);

  return {
    draft,
    usage: payload.usageMetadata ?? null,
    model,
  };
}

function extractCandidateText(payload: GeminiGenerateContentResponse) {
  const candidate = payload.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  return parts
    .map((part) => part.text?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
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

    throw new Error(`Gemini returned invalid JSON: ${text}`);
  }
}

async function fileToBase64(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}
