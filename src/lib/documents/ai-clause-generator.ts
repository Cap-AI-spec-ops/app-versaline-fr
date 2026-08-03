import "server-only";

import { getActionConfig, type AiProvider } from "@/lib/ai/model-router";
import { resolveRuntimeModelSelection } from "@/lib/ai/runtime-model-selection";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

export async function generateSpecialClause(
  userPrompt: string,
  options?: {
    workspaceId?: string;
    countryCode?: string;
    documentType?: string;
  },
): Promise<string> {
  const normalizedPrompt = userPrompt.trim();

  if (!normalizedPrompt) {
    throw new Error("A clause instruction is required.");
  }

  const actionType = "document_special_clause" as const;
  const actionConfig = getActionConfig(actionType);
  const runtimeSelection = options?.workspaceId
    ? await resolveRuntimeModelSelection({
        actionType,
        workspaceId: options.workspaceId,
      })
    : null;

  const provider = runtimeSelection?.textProvider ?? actionConfig.provider;
  const model = runtimeSelection?.textModel ?? actionConfig.model;
  const prompt = buildClausePrompt({
    userPrompt: normalizedPrompt,
    countryCode: options?.countryCode ?? "FR",
    documentType: options?.documentType ?? "document_contractuel",
  });

  const clause = await generateWithProvider(provider, model, prompt);
  return clause.trim();
}

function buildClausePrompt(options: {
  userPrompt: string;
  countryCode: string;
  documentType: string;
}) {
  return [
    "You draft French real-estate contract clauses for professional agencies.",
    "Convert the informal instruction into one precise contractual clause in French.",
    "Requirements:",
    "- Output only the final clause text.",
    "- Use formal legal French.",
    "- Avoid ambiguity, placeholders, and bullet points.",
    "- Do not add explanations or legal disclaimers.",
    `- Jurisdiction: ${options.countryCode}.`,
    `- Target document family: ${options.documentType}.`,
    `Informal instruction: ${options.userPrompt}`,
  ].join("\n");
}

async function generateWithProvider(provider: AiProvider, model: string, prompt: string) {
  if (provider === "mistral") {
    const apiKey = process.env.MISTRAL_API_KEY?.trim();

    if (!apiKey) {
      throw new Error("MISTRAL_API_KEY is not configured.");
    }

    const response = await fetch(`${process.env.MISTRAL_API_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are a precise French contract drafting assistant." },
          { role: "user", content: prompt },
        ],
      }),
    });

    return extractOpenAiStyleText(await response.json(), response.ok);
  }

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not configured.");
    }

    const response = await fetch(`${process.env.ANTHROPIC_API_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 300,
        temperature: 0.2,
        system: "You are a precise French contract drafting assistant.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    return extractAnthropicText(await response.json(), response.ok);
  }

  if (provider === "xai") {
    const apiKey = process.env.XAI_API_KEY?.trim();

    if (!apiKey) {
      throw new Error("XAI_API_KEY is not configured.");
    }

    const response = await fetch(`${process.env.XAI_API_BASE_URL?.trim() || DEFAULT_XAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are a precise French contract drafting assistant." },
          { role: "user", content: prompt },
        ],
      }),
    });

    return extractOpenAiStyleText(await response.json(), response.ok);
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const response = await fetch(`${process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL}/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      generationConfig: {
        temperature: 0.2,
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    }),
  });

  return extractGeminiText(await response.json(), response.ok);
}

function extractOpenAiStyleText(payload: unknown, isOk: boolean) {
  const text =
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { choices?: Array<{ message?: { content?: string } }> }).choices)
      ? (payload as { choices: Array<{ message?: { content?: string } }> }).choices[0]?.message?.content
      : null;

  if (!isOk || typeof text !== "string" || !text.trim()) {
    throw new Error("Clause generation failed for the selected provider.");
  }

  return text;
}

function extractAnthropicText(payload: unknown, isOk: boolean) {
  const content =
    typeof payload === "object" && payload !== null
      ? (payload as { content?: Array<{ type?: string; text?: string }> }).content
      : null;
  const text = Array.isArray(content)
    ? content.find((item) => item?.type === "text")?.text
    : null;

  if (!isOk || typeof text !== "string" || !text.trim()) {
    throw new Error("Clause generation failed for the selected provider.");
  }

  return text;
}

function extractGeminiText(payload: unknown, isOk: boolean) {
  const candidates =
    typeof payload === "object" && payload !== null
      ? (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates
      : null;
  const text = Array.isArray(candidates)
    ? candidates[0]?.content?.parts?.map((part) => part.text ?? "").join("")
    : null;

  if (!isOk || typeof text !== "string" || !text.trim()) {
    throw new Error("Clause generation failed for Gemini.");
  }

  return text;
}