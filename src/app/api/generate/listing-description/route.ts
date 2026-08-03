import { NextRequest, NextResponse } from "next/server";

import { generateWithCredits, InsufficientCreditsError } from "@/lib/ai/generate-with-credits";
import { enhanceListingPhotosWithProvider } from "@/lib/ai/listing-photo-enhancement-provider";
import type { ListingPhotoEnhancementStyle } from "@/lib/ai/listing-photo-enhancement-provider";
import { getActionConfig, type AiProvider } from "@/lib/ai/model-router";
import { generateListingDescriptionWithProvider } from "@/lib/ai/listing-description-provider";
import { type ListingDescriptionTone, type ListingDisclosureDetails, type ListingDescriptionLength } from "@/lib/ai/listing-description";
import { resolveRuntimeModelSelection } from "@/lib/ai/runtime-model-selection";
import { resolveWorkspaceMarketContext } from "@/lib/market/resolve-workspace-market-context";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO = 0.1;

export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ error: "Supabase client unavailable" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

  if (profileError || !profileData) {
    return NextResponse.json({ error: "Could not load current profile" }, { status: 403 });
  }

  const profile = profileData as { workspace_id?: string | null; role?: string | null };

  if (!profile.workspace_id) {
    return NextResponse.json({ error: "No workspace on current profile" }, { status: 400 });
  }

  const formData = await request.formData();
  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  const propertyType = String(formData.get("propertyType") ?? "").trim();
  const transactionType = parseTransactionType(String(formData.get("transactionType") ?? ""));
  const descriptionLength = parseDescriptionLength(String(formData.get("descriptionLength") ?? ""));
  const city = String(formData.get("city") ?? "").trim();
  const neighborhood = String(formData.get("neighborhood") ?? "").trim();
  const rooms = String(formData.get("rooms") ?? formData.get("bedrooms") ?? "").trim();
  const bathrooms = String(formData.get("bathrooms") ?? "").trim();
  const surfaceArea = String(formData.get("surfaceArea") ?? "").trim();
  const surfaceUnit = String(formData.get("surfaceUnit") ?? "m²").trim();
  const tone = parseTone(String(formData.get("tone") ?? "professional"));
  const notes = String(formData.get("notes") ?? "").trim();
  const secondaryLanguage = readOptionalFormValue(formData, "secondaryLanguage");
  const marketCountryCode = readOptionalFormValue(formData, "marketCountryCode");
  const marketLocale = readOptionalFormValue(formData, "marketLocale");
  const marketLanguage = readOptionalFormValue(formData, "marketLanguage");
  const marketTimezone = readOptionalFormValue(formData, "marketTimezone");
  const highlights = String(formData.get("highlights") ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const dpeEnergyClass = readOptionalFormValue(formData, "dpeEnergyClass");
  const dpeClimateClass = readOptionalFormValue(formData, "dpeClimateClass");
  const feePrice = readOptionalFormValue(formData, "feePrice");
  const feeCharge = readOptionalFormValue(formData, "feeCharge");
  const coOwnershipLotNumber = readOptionalFormValue(formData, "coOwnershipLotNumber");
  const coOwnershipAnnualCharges = readOptionalFormValue(formData, "coOwnershipAnnualCharges");
  const shouldEnhancePhotos = parseBooleanFormValue(formData.get("enhancePhotos"));
  const enhancementStyle = parseEnhancementStyle(formData.get("enhancementStyle"));
  const imageFiles = formData.getAll("images").filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (workspaceId !== profile.workspace_id) {
    return NextResponse.json({ error: "Workspace mismatch" }, { status: 403 });
  }

  if (!propertyType) {
    return NextResponse.json({ error: "Property type is required" }, { status: 400 });
  }

  if (!transactionType) {
    return NextResponse.json({ error: "Listing type is required (sale or rent)" }, { status: 400 });
  }

  if (!descriptionLength) {
    return NextResponse.json({ error: "Description length is required" }, { status: 400 });
  }

  if (!city) {
    return NextResponse.json({ error: "City is required" }, { status: 400 });
  }

  if (!rooms) {
    return NextResponse.json({ error: "Amount of rooms is required" }, { status: 400 });
  }

  if (!surfaceArea) {
    return NextResponse.json({ error: "Surface area is required" }, { status: 400 });
  }

  if (imageFiles.length === 0) {
    return NextResponse.json({ error: "Please upload at least one photo" }, { status: 400 });
  }

  const marketOverrides =
    marketCountryCode || marketLocale || marketLanguage || marketTimezone
      ? {
          countryCode: marketCountryCode ?? undefined,
          locale: marketLocale ?? undefined,
          language: marketLanguage ?? undefined,
          timezone: marketTimezone ?? undefined,
        }
      : undefined;

  const market = await resolveWorkspaceMarketContext({
    workspaceId,
    overrides: marketOverrides,
  });
  const actionType = "listing_description" as const;
  const enhancementActionType = "photo_enhancement_prompt" as const;
  const actionConfig = getActionConfig(actionType);
  const runtimeModelSelection = await resolveRuntimeModelSelection({
    actionType,
    workspaceId,
  });
  const enhancementRuntimeSelection = await resolveRuntimeModelSelection({
    actionType: enhancementActionType,
    workspaceId,
  });
  const resolvedVisionProvider = runtimeModelSelection?.visionProvider ?? actionConfig.provider;
  const resolvedVisionModel = runtimeModelSelection?.visionModel ?? null;
  const resolvedEnhancementProvider =
    enhancementRuntimeSelection?.visionProvider ??
    enhancementRuntimeSelection?.textProvider ??
    resolvedVisionProvider;
  const resolvedEnhancementModel =
    enhancementRuntimeSelection?.visionModel ??
    enhancementRuntimeSelection?.textModel ??
    resolvedVisionModel;
  const effectiveEnhancementProvider: AiProvider =
    resolvedEnhancementProvider === "gemini" ? "gemini" : "gemini";
  const effectiveEnhancementModel =
    resolvedEnhancementProvider === "gemini"
      ? resolvedEnhancementModel
      : process.env.GEMINI_LISTING_PHOTO_ENHANCEMENT_MODEL?.trim() || null;

  const idempotencyKey = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
  const enhancementIdempotencyKey = `${idempotencyKey}:photo-enhancement`;
  const plannedEnhancementCredits = roundCreditAmount(imageFiles.length * PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO);
  let enhancementCharge: CreditMutationResult | null = null;
  let enhancedPreviewDataUrls: Array<string | null> = [];
  let enhancementApplied = false;
  let enhancementCreditsUsed = 0;
  let enhancementWarning: string | null = null;
  let imagesForDescription = imageFiles;

  try {
    if (shouldEnhancePhotos && imageFiles.length > 0) {
      try {
        if (plannedEnhancementCredits > 0) {
          enhancementCharge = await deductEnhancementCredits({
            workspaceId,
            credits: plannedEnhancementCredits,
            actionType,
            idempotencyKey: enhancementIdempotencyKey,
            provider: effectiveEnhancementProvider,
            model: effectiveEnhancementModel ?? "default",
            photoCount: imageFiles.length,
          });
        }

        const enhancement = await enhanceListingPhotosWithProvider({
          imageFiles,
          provider: effectiveEnhancementProvider,
          modelOverride: effectiveEnhancementModel,
          style: enhancementStyle,
        });

        imagesForDescription = enhancement.enhancedFiles;
        enhancedPreviewDataUrls = enhancement.previewDataUrls;
        enhancementApplied = enhancement.successfulPhotoCount > 0;
        enhancementCreditsUsed = roundCreditAmount(
          enhancement.successfulPhotoCount * PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO,
        );

        const failedCount = enhancement.failedPhotoCount;

        if (failedCount > 0) {
          const refundAmount = roundCreditAmount(
            failedCount * PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO,
          );

          if (refundAmount > 0 && enhancementCharge && !enhancementCharge.idempotent) {
            await refundEnhancementCredits({
              workspaceId,
              credits: refundAmount,
              actionType,
              idempotencyKey: `${enhancementIdempotencyKey}:partial-refund:${failedCount}`,
              provider: effectiveEnhancementProvider,
              model: effectiveEnhancementModel ?? "default",
            });
          }

          enhancementWarning = `Enhanced ${enhancement.successfulPhotoCount}/${imageFiles.length} photos. ${failedCount} photo${failedCount > 1 ? "s" : ""} kept as original.`;
        }
      } catch (enhancementError) {
        if (enhancementCharge && !enhancementCharge.idempotent) {
          await refundEnhancementCredits({
            workspaceId,
            credits: plannedEnhancementCredits,
            actionType,
            idempotencyKey: enhancementIdempotencyKey,
            provider: effectiveEnhancementProvider,
            model: effectiveEnhancementModel ?? "default",
          });
        }

        enhancementCharge = null;
        enhancementWarning = buildEnhancementWarningMessage({
          error: enhancementError,
          role: profile.role,
          provider: effectiveEnhancementProvider,
          model: effectiveEnhancementModel,
        });
      }
    }

    const { result, creditsUsed, newBalance } = await generateWithCredits({
      workspaceId,
      actionType,
      idempotencyKey,
      telemetryProvider: resolvedVisionProvider,
      telemetryModel: resolvedVisionModel ?? actionConfig.model,
      generationFn: async () => {
        const { draft, usage, model, provider } = await generateListingDescriptionWithProvider({
          market,
          propertyType,
          transactionType,
          descriptionLength,
          city,
          neighborhood,
          rooms,
          bathrooms,
          surfaceArea,
          surfaceUnit,
          highlights,
          notes,
          tone,
          imageCount: imageFiles.length,
          imageNames: imageFiles.map((file) => file.name),
          secondaryLanguage: secondaryLanguage ?? null,
          disclosures: buildDisclosureDetails({
            dpeEnergyClass,
            dpeClimateClass,
            feePrice,
            feeCharge,
            coOwnershipLotNumber,
            coOwnershipAnnualCharges,
          }),
          imageFiles: imagesForDescription,
          provider: resolvedVisionProvider,
          modelOverride: resolvedVisionModel,
        });

        return {
          result: draft,
          telemetry: {
            provider,
            model,
            usage,
          },
        };
      },
    });

    return NextResponse.json({
      ok: true,
      result,
      creditsUsed: roundCreditAmount(creditsUsed + enhancementCreditsUsed),
      baseCreditsUsed: creditsUsed,
      enhancementCreditsUsed,
      enhancementApplied,
      enhancementWarning,
      enhancedPreviewDataUrls,
      newBalance,
    });
  } catch (error) {
    if (enhancementApplied && enhancementCharge && !enhancementCharge.idempotent) {
      await refundEnhancementCredits({
        workspaceId,
        credits: enhancementCreditsUsed,
        actionType,
        idempotencyKey: enhancementIdempotencyKey,
        provider: effectiveEnhancementProvider,
        model: effectiveEnhancementModel ?? "default",
      });
    }

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

    const message = error instanceof Error ? error.message : "Listing description generation failed";
    const safeMessage =
      profile.role === "super_admin"
        ? message
        : "Could not generate description. Please try again with fewer or smaller photos. If the problem persists, please contact support.";
    return NextResponse.json({ error: safeMessage }, { status: 500 });
  }
}

function parseTransactionType(value: string): "sale" | "rent" | null {
  if (value === "sale" || value === "rent") {
    return value;
  }

  return null;
}

function parseDescriptionLength(value: string): ListingDescriptionLength | null {
  if (value === "short" || value === "medium" || value === "long") {
    return value;
  }

  return null;
}

function buildDisclosureDetails(values: {
  dpeEnergyClass: string | null;
  dpeClimateClass: string | null;
  feePrice: string | null;
  feeCharge: string | null;
  coOwnershipLotNumber: string | null;
  coOwnershipAnnualCharges: string | null;
}): ListingDisclosureDetails | undefined {
  const nextValues = {
    dpeEnergyClass: values.dpeEnergyClass ?? undefined,
    dpeClimateClass: values.dpeClimateClass ?? undefined,
    feePrice: values.feePrice ?? undefined,
    feeCharge: values.feeCharge ?? undefined,
    coOwnershipLotNumber: values.coOwnershipLotNumber ?? undefined,
    coOwnershipAnnualCharges: values.coOwnershipAnnualCharges ?? undefined,
  };

  const hasAnyValue = Object.values(nextValues).some((value) => typeof value === "string" && value.trim().length > 0);

  return hasAnyValue ? nextValues : undefined;
}

function parseTone(value: string): ListingDescriptionTone {
  if (value === "warm" || value === "premium" || value === "concise") {
    return value;
  }

  return "professional";
}

function readOptionalFormValue(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseBooleanFormValue(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function parseEnhancementStyle(value: FormDataEntryValue | null): ListingPhotoEnhancementStyle {
  if (typeof value !== "string") {
    return "luxury_editorial";
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "clean_premium" || normalized === "premium_plus" || normalized === "luxury_editorial") {
    return normalized;
  }

  return "luxury_editorial";
}

function roundCreditAmount(value: number) {
  return Math.round(value * 10) / 10;
}

type CreditMutationResult = {
  workspace_id: string;
  transaction_id: string;
  transaction_type: "deduction" | "refund" | "topup";
  amount: number;
  balance: number;
  idempotent: boolean;
};

async function deductEnhancementCredits(input: {
  workspaceId: string;
  credits: number;
  actionType: "listing_description";
  idempotencyKey: string;
  provider: AiProvider;
  model: string;
  photoCount: number;
}) {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    throw new Error("Supabase server client is not available");
  }

  const { data: balanceData, error: balanceError } = await supabase.rpc("get_workspace_credit_balance", {
    p_workspace_id: input.workspaceId,
  });

  if (balanceError) {
    throw new Error(balanceError.message);
  }

  const currentBalance = (balanceData as { credit_balance?: number | null } | null)?.credit_balance ?? 0;

  if (currentBalance < input.credits) {
    throw new InsufficientCreditsError(input.workspaceId, input.actionType, input.credits, currentBalance);
  }

  const { data: deductionData, error: deductionError } = await supabase.rpc("deduct_workspace_credit", {
    p_workspace_id: input.workspaceId,
    p_amount: input.credits,
    p_action: input.actionType,
    p_idempotency_key: input.idempotencyKey,
    p_metadata: {
      actionType: input.actionType,
      phase: "photo_enhancement",
      provider: input.provider,
      model: input.model,
      credits_per_photo: PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO,
      photo_count: input.photoCount,
    },
  });

  if (deductionError) {
    if (deductionError.message.toLowerCase().includes("insufficient")) {
      throw new InsufficientCreditsError(input.workspaceId, input.actionType, input.credits, currentBalance);
    }

    throw new Error(deductionError.message);
  }

  const charge = deductionData as CreditMutationResult | null;

  if (!charge) {
    throw new Error("Photo enhancement credit deduction did not return a result");
  }

  return charge;
}

async function refundEnhancementCredits(input: {
  workspaceId: string;
  credits: number;
  actionType: "listing_description";
  idempotencyKey: string;
  provider: AiProvider;
  model: string;
}) {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return;
  }

  const { error } = await supabase.rpc("refund_workspace_credit", {
    p_workspace_id: input.workspaceId,
    p_amount: input.credits,
    p_action: input.actionType,
    p_idempotency_key: input.idempotencyKey,
    p_metadata: {
      actionType: input.actionType,
      phase: "photo_enhancement",
      provider: input.provider,
      model: input.model,
    },
  });

  if (error) {
    console.error("Failed to refund photo enhancement credits", error);
  }
}

function buildEnhancementWarningMessage(input: {
  error: unknown;
  role?: string | null;
  provider: AiProvider;
  model: string | null;
}) {
  const message = input.error instanceof Error ? input.error.message : "Unknown enhancement error";

  if (input.role === "super_admin") {
    return `Photo enhancement skipped (${input.provider}${input.model ? `/${input.model}` : ""}): ${message}`;
  }

  return "Enhancement failed. If the issue persists, please contact support.";
}


