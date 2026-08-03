import "server-only";

import type { AiProvider } from "@/lib/ai/model-router";
import type { AITokenUsage } from "@/lib/ai/telemetry";
import sharp from "sharp";

export type ListingPhotoEnhancementStyle = "clean_premium" | "premium_plus" | "luxury_editorial";

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash-preview-image-generation";
const FALLBACK_GEMINI_IMAGE_MODELS = [
  "gemini-2.0-flash-preview-image-generation",
  "gemini-2.5-flash-image-preview",
  "gemini-2.0-flash-exp-image-generation",
] as const;
const PROVIDER_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.LISTING_PHOTO_ENHANCEMENT_PROVIDER_TIMEOUT_MS ?? "90000",
  10,
);

const QUALITY_ONLY_ENHANCEMENT_PROMPT = [
  "You are a real-estate photo enhancement assistant.",
  "Apply a bold, premium real-estate editorial enhancement.",
  "STRICTLY preserve all scene content and geometry.",
  "Do NOT add, remove, replace, invent, or move any object or fixture.",
  "Do NOT stage the room and do NOT alter architecture.",
  "Do NOT change room layout, furniture count, bathroom fixtures, or appliances.",
  "Keep all original objects exactly present, but aggressively improve visual quality and presentation.",
  "Target style: bright, clean, high-end listing look with crisp clarity and premium color grading.",
  "Use stronger edits than basic correction: balanced HDR-like tonality, deeper contrast, cleaner whites, richer but natural colors, reduced noise, and clearer detail.",
  "Improve visual impact so the image clearly looks professionally retouched.",
  "Avoid overprocessing artifacts, halos, fake textures, or surreal distortions.",
  "Keep the result photorealistic and marketable for real-estate listings.",
  "Return only the enhanced image.",
].join("\n");

type ListingPhotoEnhancementProviderResult = {
  enhancedFiles: File[];
  previewDataUrls: Array<string | null>;
  successfulPhotoCount: number;
  failedPhotoCount: number;
  warnings: string[];
  usage: AITokenUsage | null;
  provider: AiProvider;
  model: string;
};

export async function enhanceListingPhotosWithProvider(input: {
  imageFiles: File[];
  provider: AiProvider;
  modelOverride?: string | null;
  style?: ListingPhotoEnhancementStyle;
}): Promise<ListingPhotoEnhancementProviderResult> {
  if (input.provider !== "gemini") {
    throw new Error(`ENHANCEMENT_UNSUPPORTED_PROVIDER: '${input.provider}' is not supported yet`);
  }

  return enhanceListingPhotosWithGemini(input);
}

async function enhanceListingPhotosWithGemini(input: {
  imageFiles: File[];
  provider: AiProvider;
  modelOverride?: string | null;
  style?: ListingPhotoEnhancementStyle;
}): Promise<ListingPhotoEnhancementProviderResult> {
    const style = input.style ?? "luxury_editorial";

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const sanitizedOverride = sanitizeGeminiEnhancementModel(input.modelOverride);
  const sanitizedEnvModel = sanitizeGeminiEnhancementModel(
    process.env.GEMINI_LISTING_PHOTO_ENHANCEMENT_MODEL?.trim() ?? null,
  );
  const primaryModel = sanitizedOverride || sanitizedEnvModel || DEFAULT_GEMINI_MODEL;
  const baseUrl = process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL;

  const enhancedFiles: File[] = [];
  const previewDataUrls: Array<string | null> = [];
  const warnings: string[] = [];
  const usageRows: Array<GeminiGenerateContentResponse["usageMetadata"]> = [];
  let successfulPhotoCount = 0;
  let allFailuresSummary: string[] = [];
  let finalModel = primaryModel;
  const candidateModels = Array.from(
    new Set([
      primaryModel,
      ...FALLBACK_GEMINI_IMAGE_MODELS,
    ]),
  );

  for (let index = 0; index < input.imageFiles.length; index += 1) {
    const photo = input.imageFiles[index];
    const failureReasons: string[] = [];
    let enhancedForPhoto = false;

    for (const model of candidateModels) {
      try {
        const result = await enhanceSingleImageWithGeminiModel({
          file: photo,
          index,
          apiKey,
          baseUrl,
          model,
        });
        const sourceSelection = await selectBestSourceForPremiumGrade({
          originalFile: photo,
          aiEnhancedFile: result.file,
        });
        const graded = await applyLocalPremiumGrade(sourceSelection.file, style);

        enhancedFiles.push(graded.file);
        previewDataUrls.push(graded.previewDataUrl);
        usageRows.push(result.usage);
        successfulPhotoCount += 1;
        finalModel = finalModel === model || successfulPhotoCount === 1 ? model : "mixed-gemini-image-models";
        if (sourceSelection.usedOriginal) {
          warnings.push(`Photo ${index + 1}: AI output quality was degraded, used premium grade from original photo.`);
        }
        enhancedForPhoto = true;
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "enhancement failed";
        failureReasons.push(`[${model}] ${reason}`);
      }
    }

    if (enhancedForPhoto) {
      continue;
    }

    try {
      const graded = await applyLocalPremiumGrade(photo, style);
      enhancedFiles.push(graded.file);
      previewDataUrls.push(graded.previewDataUrl);
      successfulPhotoCount += 1;
      warnings.push(
        `Photo ${index + 1}: AI enhancement unavailable. Applied local premium grading fallback.`,
      );
      finalModel = finalModel === "mixed-gemini-image-models" ? finalModel : `${finalModel}+local-grade`;
      continue;
    } catch {
      // Keep original photo when both AI and local grading fail.
    }

    enhancedFiles.push(photo);
    previewDataUrls.push(null);
    const summary = `Photo ${index + 1}: ${failureReasons.join(" | ")}`;
    warnings.push(summary);
    allFailuresSummary.push(summary);
  }

  if (successfulPhotoCount === 0) {
    throw new Error(`ENHANCEMENT_ALL_FAILED: ${allFailuresSummary.join(" || ")}`);
  }

  const mergedUsage = mergeGeminiUsage(usageRows);

  return {
    enhancedFiles,
    previewDataUrls,
    successfulPhotoCount,
    failedPhotoCount: input.imageFiles.length - successfulPhotoCount,
    warnings,
    usage: normalizeGeminiUsage(mergedUsage),
    provider: "gemini",
    model: finalModel,
  };
}

function sanitizeGeminiEnhancementModel(model: string | null | undefined) {
  if (!model) {
    return null;
  }

  const normalized = model.trim();

  if (!normalized) {
    return null;
  }

  // Image enhancement requires an image-generation-capable model id.
  if (!normalized.toLowerCase().includes("image")) {
    return null;
  }

  return normalized;
}

async function enhanceSingleImageWithGeminiModel(input: {
  file: File;
  index: number;
  apiKey: string;
  baseUrl: string;
  model: string;
}) {
  const imageBase64 = await fileToBase64(input.file);
  const response = await fetchWithTimeout(
    `${input.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`,
    {
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
                text: QUALITY_ONLY_ENHANCEMENT_PROMPT,
              },
              {
                inlineData: {
                  mimeType: input.file.type || "image/jpeg",
                  data: imageBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `ENHANCEMENT_PROVIDER_ERROR: Gemini enhancement failed for photo ${input.index + 1} with model '${input.model}' (${response.status}): ${errorText}`,
    );
  }

  const payload = (await response.json()) as GeminiGenerateContentResponse;
  const imagePart = extractGeminiImagePart(payload);

  if (!imagePart?.data) {
    throw new Error(
      `ENHANCEMENT_NO_IMAGE_OUTPUT: Gemini did not return an enhanced image for photo ${input.index + 1} with model '${input.model}'`,
    );
  }

  const outputMimeType = imagePart.mimeType?.trim() || input.file.type || "image/jpeg";
  const outputFile = base64ToFile({
    base64: imagePart.data,
    mimeType: outputMimeType,
    originalName: input.file.name,
  });

  return {
    file: outputFile,
    previewDataUrl: `data:${outputMimeType};base64,${imagePart.data}`,
    usage: payload.usageMetadata,
  };
}

async function applyLocalPremiumGrade(file: File, style: ListingPhotoEnhancementStyle) {
  const sourceBuffer = Buffer.from(await file.arrayBuffer());
  const settings = getStyleSettings(style);
  const pipeline = sharp(sourceBuffer, { failOn: "none" })
    .rotate()
    .normalize()
    .median(1)
    .modulate({
      brightness: settings.brightness,
      saturation: settings.saturation,
      hue: settings.hue,
    })
    .linear(settings.linearA, settings.linearB)
    .gamma(settings.gamma)
    .sharpen({
      sigma: settings.sharpenSigma,
      m1: settings.sharpenM1,
      m2: settings.sharpenM2,
      x1: 2,
      y2: settings.sharpenY2,
      y3: settings.sharpenY3,
    });

  const mimeType = normalizeOutputMimeType(file.type);
  let outputBuffer: Buffer;

  if (mimeType === "image/png") {
    outputBuffer = await pipeline.png({ compressionLevel: 9, quality: 95 }).toBuffer();
  } else if (mimeType === "image/webp") {
    outputBuffer = await pipeline.webp({ quality: 95 }).toBuffer();
  } else {
    outputBuffer = await pipeline.jpeg({ quality: 97, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
  }

  const outputFile = bufferToFile({
    buffer: outputBuffer,
    mimeType,
    originalName: file.name,
  });

  return {
    file: outputFile,
    previewDataUrl: `data:${mimeType};base64,${outputBuffer.toString("base64")}`,
  };
}

function getStyleSettings(style: ListingPhotoEnhancementStyle) {
  if (style === "clean_premium") {
    return {
      brightness: 1.05,
      saturation: 1.11,
      hue: 0,
      linearA: 1.05,
      linearB: -2,
      gamma: 1.02,
      sharpenSigma: 1.0,
      sharpenM1: 1,
      sharpenM2: 1.4,
      sharpenY2: 10,
      sharpenY3: 20,
    };
  }

  if (style === "premium_plus") {
    return {
      brightness: 1.08,
      saturation: 1.16,
      hue: 1,
      linearA: 1.07,
      linearB: -3,
      gamma: 1.03,
      sharpenSigma: 1.1,
      sharpenM1: 1,
      sharpenM2: 1.7,
      sharpenY2: 12,
      sharpenY3: 24,
    };
  }

  return {
    brightness: 1.12,
    saturation: 1.24,
    hue: 2,
    linearA: 1.1,
    linearB: -4,
    gamma: 1.03,
    sharpenSigma: 1.15,
    sharpenM1: 1.1,
    sharpenM2: 1.9,
    sharpenY2: 13,
    sharpenY3: 26,
  };
}

async function selectBestSourceForPremiumGrade(input: {
  originalFile: File;
  aiEnhancedFile: File;
}) {
  const originalBuffer = Buffer.from(await input.originalFile.arrayBuffer());
  const aiBuffer = Buffer.from(await input.aiEnhancedFile.arrayBuffer());

  const [originalMetadata, aiMetadata] = await Promise.all([
    sharp(originalBuffer, { failOn: "none" }).metadata(),
    sharp(aiBuffer, { failOn: "none" }).metadata(),
  ]);

  const originalPixels = (originalMetadata.width ?? 0) * (originalMetadata.height ?? 0);
  const aiPixels = (aiMetadata.width ?? 0) * (aiMetadata.height ?? 0);
  const aiIsDownscaled = originalPixels > 0 && aiPixels > 0 && aiPixels < originalPixels * 0.92;

  if (aiIsDownscaled) {
    return {
      file: input.originalFile,
      usedOriginal: true,
    };
  }

  return {
    file: input.aiEnhancedFile,
    usedOriginal: false,
  };
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
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

function extractGeminiImagePart(payload: GeminiGenerateContentResponse) {
  const candidate = payload.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];

  return parts.find((part) => part.inlineData?.data)?.inlineData;
}

function mergeGeminiUsage(usages: Array<GeminiGenerateContentResponse["usageMetadata"]>) {
  return usages.reduce(
    (accumulator, usage) => ({
      promptTokenCount: (accumulator.promptTokenCount ?? 0) + (usage?.promptTokenCount ?? 0),
      candidatesTokenCount: (accumulator.candidatesTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0),
      totalTokenCount: (accumulator.totalTokenCount ?? 0) + (usage?.totalTokenCount ?? 0),
      cachedContentTokenCount: (accumulator.cachedContentTokenCount ?? 0) + (usage?.cachedContentTokenCount ?? 0),
    }),
    {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
      cachedContentTokenCount: 0,
    },
  );
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

function base64ToFile(input: { base64: string; mimeType: string; originalName: string }) {
  const extension = extensionFromMimeType(input.mimeType);
  const baseName = input.originalName.includes(".")
    ? input.originalName.slice(0, input.originalName.lastIndexOf("."))
    : input.originalName;
  const filename = `${baseName}-enhanced.${extension}`;
  const buffer = Buffer.from(input.base64, "base64");

  return new File([buffer], filename, {
    type: input.mimeType,
    lastModified: Date.now(),
  });
}

function bufferToFile(input: { buffer: Buffer; mimeType: string; originalName: string }) {
  const extension = extensionFromMimeType(input.mimeType);
  const baseName = input.originalName.includes(".")
    ? input.originalName.slice(0, input.originalName.lastIndexOf("."))
    : input.originalName;
  const filename = `${baseName}-enhanced.${extension}`;

  return new File([input.buffer], filename, {
    type: input.mimeType,
    lastModified: Date.now(),
  });
}

function normalizeOutputMimeType(mimeType: string | undefined) {
  if (mimeType === "image/png" || mimeType === "image/webp" || mimeType === "image/jpeg") {
    return mimeType;
  }

  return "image/jpeg";
}

function extensionFromMimeType(mimeType: string) {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  return "jpg";
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
