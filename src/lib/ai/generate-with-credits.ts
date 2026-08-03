import "server-only";

import { estimateCost, getActionConfig, type ActionType, type AiProvider } from "@/lib/ai/model-router";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildGenerationTelemetry,
  type AITokenUsage,
  type GenerationEnvelope,
} from "@/lib/ai/telemetry";

type WorkspaceBalanceRow = {
  credit_balance: number;
};

type WorkspaceBalanceResponse = {
  credit_balance?: number | null;
};

type CreditMutationResult = {
  workspace_id: string;
  transaction_id: string;
  transaction_type: "deduction" | "refund" | "topup";
  amount: number;
  balance: number;
  idempotent: boolean;
};

type GenerateWithCreditsArgs<TResult> = {
  workspaceId: string;
  actionType: ActionType;
  generationFn: () => Promise<TResult | GenerationEnvelope<TResult>>;
  idempotencyKey: string;
  telemetryProvider?: AiProvider;
  telemetryModel?: string;
};

type GenerateWithCreditsResult<TResult> = {
  result: TResult;
  creditsUsed: number;
  newBalance: number;
};

function isGenerationEnvelope<TResult>(
  value: TResult | GenerationEnvelope<TResult>,
): value is GenerationEnvelope<TResult> {
  return typeof value === "object" && value !== null && "result" in value;
}

function buildCacheTelemetry(usage: AITokenUsage | null | undefined) {
  if (!usage) {
    return null;
  }

  const cacheCreationInputTokens = usage.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;

  return {
    cacheStatus: cacheReadInputTokens > 0 ? "hit" : cacheCreationInputTokens > 0 ? "miss" : "unknown",
    cacheCreationInputTokens,
    cacheReadInputTokens,
    cacheTokenSavings: cacheReadInputTokens > 0 ? cacheReadInputTokens : 0,
  };
}

function buildCreditTransactionMetadata(options: {
  actionType: ActionType;
  provider: AiProvider;
  model: string;
  creditsUsed: number;
  balanceAfter: number;
  telemetryProvider?: AiProvider;
  telemetryModel?: string;
  usage?: AITokenUsage | null | undefined;
}) {
  const telemetryProvider = options.telemetryProvider ?? options.provider;
  const telemetryModel = options.telemetryModel ?? options.model;
  const cacheTelemetry = buildCacheTelemetry(options.usage);
  const inputTokens = options.usage?.inputTokens ?? 0;
  const outputTokens = options.usage?.outputTokens ?? 0;
  const totalTokens = options.usage?.totalTokens ?? inputTokens + outputTokens;
  const estimatedUsdCost =
    inputTokens > 0 || outputTokens > 0 ? estimateCost(options.actionType, inputTokens, outputTokens) : 0;

  return {
    actionType: options.actionType,
    provider: telemetryProvider,
    model: telemetryModel,
    credits_used: options.creditsUsed,
    balance_after: options.balanceAfter,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    estimated_usd_cost: estimatedUsdCost,
    usage_available: !!options.usage,
    ...(cacheTelemetry
      ? {
          cache_status: cacheTelemetry.cacheStatus,
          cache_creation_input_tokens: cacheTelemetry.cacheCreationInputTokens,
          cache_read_input_tokens: cacheTelemetry.cacheReadInputTokens,
          cache_token_savings: cacheTelemetry.cacheTokenSavings,
        }
      : {}),
  };
}

export class InsufficientCreditsError extends Error {
  readonly name = "InsufficientCreditsError";

  constructor(
    public readonly workspaceId: string,
    public readonly actionType: ActionType,
    public readonly requiredCredits: number,
    public readonly currentBalance: number,
  ) {
    super(
      `Insufficient credits for ${actionType}: requires ${requiredCredits}, has ${currentBalance}`,
    );
  }
}

/**
 * Reserve credits before calling the AI provider, then refund them if generation fails.
 *
 * This follows a reserve-then-refund pattern:
 * 1. Read the workspace balance and fail fast if it is obviously too low.
 * 2. Reserve the action cost via the Supabase RPC, which performs the atomic balance update.
 * 3. Run the generation function.
 * 4. If generation throws, issue a refund RPC using the same idempotency key and rethrow the original error.
 *
 * The RPC layer is still the source of truth for concurrency safety. The preflight read only avoids
 * unnecessary LLM calls when the balance is clearly insufficient.
 */
export async function generateWithCredits<TResult>({
  workspaceId,
  actionType,
  generationFn,
  idempotencyKey,
  telemetryProvider,
  telemetryModel,
}: GenerateWithCreditsArgs<TResult>): Promise<{
  result: TResult;
  creditsUsed: number;
  newBalance: number;
}> {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    throw new Error("Supabase server client is not available");
  }

  const actionConfig = getActionConfig(actionType);
  const { provider: defaultProvider, model: defaultModel, creditCost } = actionConfig;
  const provider = telemetryProvider ?? defaultProvider;
  const model = telemetryModel ?? defaultModel;

  let currentBalance = 0;

  const { data: rpcBalance, error: rpcBalanceError } = await supabase.rpc(
    "get_workspace_credit_balance",
    {
      p_workspace_id: workspaceId,
    },
  );

  if (!rpcBalanceError && rpcBalance) {
    currentBalance = (rpcBalance as WorkspaceBalanceResponse).credit_balance ?? 0;
  } else {
    const { data: balanceRow, error: balanceError } = await supabase
      .from("workspaces")
      .select("credit_balance")
      .eq("id", workspaceId)
      .single<WorkspaceBalanceRow>();

    if (balanceError) {
      throw balanceError;
    }

    currentBalance = balanceRow?.credit_balance ?? 0;
  }

  if (currentBalance < creditCost) {
    throw new InsufficientCreditsError(
      workspaceId,
      actionType,
      creditCost,
      currentBalance,
    );
  }

  const { data: deductionResult, error: deductionError } = await supabase.rpc(
    "deduct_workspace_credit",
    {
      p_workspace_id: workspaceId,
      p_amount: creditCost,
      p_action: actionType,
      p_idempotency_key: idempotencyKey,
      p_metadata: {
        actionType,
        provider,
        model,
      },
    },
  );

  if (deductionError) {
    if (deductionError.message.toLowerCase().includes("insufficient")) {
      throw new InsufficientCreditsError(
        workspaceId,
        actionType,
        creditCost,
        currentBalance,
      );
    }

    throw deductionError;
  }

  const deduction = deductionResult as CreditMutationResult | null;

  if (!deduction) {
    throw new Error("Credit deduction did not return a result");
  }

  try {
    const generationOutput = await generationFn();
    const normalizedOutput = isGenerationEnvelope(generationOutput)
      ? generationOutput
      : { result: generationOutput };

    const telemetry =
      normalizedOutput.telemetry ??
      buildGenerationTelemetry({
        provider,
        model,
        usage: normalizedOutput.usage,
      });

    const { error: metadataError } = await supabase.rpc("update_credit_transaction_metadata", {
      p_transaction_id: deduction.transaction_id,
      p_metadata: buildCreditTransactionMetadata({
        actionType,
        provider,
        model,
        creditsUsed: creditCost,
        balanceAfter: deduction.balance,
        telemetryProvider: telemetry?.provider,
        telemetryModel: telemetry?.model,
        usage: telemetry?.usage,
      }),
    });

    if (metadataError) {
      console.error("Failed to persist credit transaction metadata", metadataError);
    }

    return {
      result: normalizedOutput.result,
      creditsUsed: creditCost,
      newBalance: deduction.balance,
    };
  } catch (generationError) {
    const { error: refundError } = await supabase.rpc("refund_workspace_credit", {
      p_workspace_id: workspaceId,
      p_amount: creditCost,
      p_action: actionType,
      p_idempotency_key: idempotencyKey,
      p_metadata: {
        actionType,
        provider,
        model,
        reason: "generation_failed",
      },
    });

    if (refundError) {
      // Keep the original generation failure as the primary error.
      console.error("Failed to refund workspace credit after generation error", refundError);
    }

    throw generationError;
  }
}
