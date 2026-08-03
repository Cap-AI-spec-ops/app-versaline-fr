import { NextRequest, NextResponse } from "next/server";

import { InsufficientCreditsError } from "@/lib/ai/generate-with-credits";
import { enhanceListingPhotosWithProvider } from "@/lib/ai/listing-photo-enhancement-provider";
import type { ListingPhotoEnhancementStyle } from "@/lib/ai/listing-photo-enhancement-provider";
import { getActionConfig, type AiProvider } from "@/lib/ai/model-router";
import { resolveRuntimeModelSelection } from "@/lib/ai/runtime-model-selection";
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
  const enhancementStyle = parseEnhancementStyle(formData.get("enhancementStyle"));
  const imageFiles = formData.getAll("images").filter((entry): entry is File => entry instanceof File && entry.size > 0);

  if (workspaceId !== profile.workspace_id) {
    return NextResponse.json({ error: "Workspace mismatch" }, { status: 403 });
  }

  if (imageFiles.length === 0) {
    return NextResponse.json({ error: "Please upload at least one photo" }, { status: 400 });
  }

  const enhancementActionType = "photo_enhancement_prompt" as const;
  const listingActionType = "listing_description" as const;
  const enhancementActionConfig = getActionConfig(enhancementActionType);
  const listingActionConfig = getActionConfig(listingActionType);

  const enhancementRuntimeSelection = await resolveRuntimeModelSelection({
    actionType: enhancementActionType,
    workspaceId,
  });
  const listingRuntimeSelection = await resolveRuntimeModelSelection({
    actionType: listingActionType,
    workspaceId,
  });

  const resolvedEnhancementProvider =
    enhancementRuntimeSelection?.visionProvider ??
    enhancementRuntimeSelection?.textProvider ??
    listingRuntimeSelection?.visionProvider ??
    enhancementActionConfig.provider;
  const resolvedEnhancementModel =
    enhancementRuntimeSelection?.visionModel ??
    enhancementRuntimeSelection?.textModel ??
    listingRuntimeSelection?.visionModel ??
    listingActionConfig.model;
  const effectiveEnhancementProvider: AiProvider =
    resolvedEnhancementProvider === "gemini" ? "gemini" : "gemini";
  const effectiveEnhancementModel =
    resolvedEnhancementProvider === "gemini"
      ? (resolvedEnhancementModel ?? listingActionConfig.model)
      : (process.env.GEMINI_LISTING_PHOTO_ENHANCEMENT_MODEL?.trim() || listingActionConfig.model);

  const plannedCredits = roundCreditAmount(imageFiles.length * PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO);
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? `enhance-only:${crypto.randomUUID()}`;

  let charge: CreditMutationResult | null = null;

  try {
    if (plannedCredits > 0) {
      charge = await deductEnhancementCredits({
        workspaceId,
        credits: plannedCredits,
        idempotencyKey,
        provider: effectiveEnhancementProvider,
        model: effectiveEnhancementModel,
        photoCount: imageFiles.length,
      });
    }

    const enhancement = await enhanceListingPhotosWithProvider({
      imageFiles,
      provider: effectiveEnhancementProvider,
      modelOverride: effectiveEnhancementModel,
      style: enhancementStyle,
    });

    const successfulCredits = roundCreditAmount(
      enhancement.successfulPhotoCount * PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO,
    );
    const failedCredits = roundCreditAmount(
      enhancement.failedPhotoCount * PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO,
    );

    if (failedCredits > 0 && charge && !charge.idempotent) {
      await refundEnhancementCredits({
        workspaceId,
        credits: failedCredits,
        idempotencyKey: `${idempotencyKey}:partial-refund:${enhancement.failedPhotoCount}`,
        provider: effectiveEnhancementProvider,
        model: effectiveEnhancementModel,
      });
    }

    return NextResponse.json({
      ok: true,
      creditsUsed: successfulCredits,
      newBalance: charge?.balance,
      enhancedPreviewDataUrls: enhancement.previewDataUrls,
      provider: enhancement.provider,
      model: enhancement.model,
      warning:
        enhancement.failedPhotoCount > 0
          ? `Enhanced ${enhancement.successfulPhotoCount}/${imageFiles.length} photos. ${enhancement.failedPhotoCount} kept as original.`
          : null,
    });
  } catch (error) {
    if (charge && !charge.idempotent) {
      await refundEnhancementCredits({
        workspaceId,
        credits: plannedCredits,
        idempotencyKey,
        provider: effectiveEnhancementProvider,
        model: effectiveEnhancementModel,
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

    const message = error instanceof Error ? error.message : "Photo enhancement failed";
    const safeMessage = profile.role === "super_admin" ? message : buildSafeEnhancementError(message);

    return NextResponse.json({ error: safeMessage }, { status: 500 });
  }
}

type CreditMutationResult = {
  workspace_id: string;
  transaction_id: string;
  transaction_type: "deduction" | "refund" | "topup";
  amount: number;
  balance: number;
  idempotent: boolean;
};

function roundCreditAmount(value: number) {
  return Math.round(value * 10) / 10;
}

async function deductEnhancementCredits(input: {
  workspaceId: string;
  credits: number;
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
    throw new InsufficientCreditsError(input.workspaceId, "photo_enhancement_prompt", input.credits, currentBalance);
  }

  const { data: deductionData, error: deductionError } = await supabase.rpc("deduct_workspace_credit", {
    p_workspace_id: input.workspaceId,
    p_amount: input.credits,
    p_action: "photo_enhancement_prompt",
    p_idempotency_key: input.idempotencyKey,
    p_metadata: {
      actionType: "photo_enhancement_prompt",
      phase: "photo_enhancement_only",
      provider: input.provider,
      model: input.model,
      credits_per_photo: PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO,
      photo_count: input.photoCount,
    },
  });

  if (deductionError) {
    if (deductionError.message.toLowerCase().includes("insufficient")) {
      throw new InsufficientCreditsError(input.workspaceId, "photo_enhancement_prompt", input.credits, currentBalance);
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
    p_action: "photo_enhancement_prompt",
    p_idempotency_key: input.idempotencyKey,
    p_metadata: {
      actionType: "photo_enhancement_prompt",
      phase: "photo_enhancement_only",
      provider: input.provider,
      model: input.model,
    },
  });

  if (error) {
    console.error("Failed to refund photo enhancement credits", error);
  }
}

function buildSafeEnhancementError(message: string) {
  void message;
  return "Enhancement failed. If the issue persists, please contact support.";
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
